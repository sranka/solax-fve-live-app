package com.github.sranka.solax_fve_realtime_app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.Context;
import android.net.wifi.WifiManager;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "SettingsTransfer")
public class SettingsTransferPlugin extends Plugin {

    private static final int DEFAULT_PORT = 8765;
    private static final int TIMEOUT_SECONDS = 120;

    private ServerSocket serverSocket;
    private PluginCall pendingCall;
    private ScheduledFuture<?> timeoutFuture;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    @PluginMethod
    public void getLocalIp(PluginCall call) {
        WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm == null) {
            call.reject("WifiManager not available");
            return;
        }
        android.net.wifi.WifiInfo info = wm.getConnectionInfo();
        int ip = info.getIpAddress();
        if (ip == 0) {
            call.reject("Not connected to WiFi");
            return;
        }
        String ipStr = (ip & 0xFF) + "." + ((ip >> 8) & 0xFF) + "." + ((ip >> 16) & 0xFF) + "." + ((ip >> 24) & 0xFF);
        JSObject result = new JSObject();
        result.put("ip", ipStr);
        call.resolve(result);
    }

    @PluginMethod
    public synchronized void startServer(PluginCall call) {
        if (serverSocket != null) {
            call.reject("Server already running");
            return;
        }

        int port = call.getInt("port", DEFAULT_PORT);
        String token = call.getString("token", "");

        call.setKeepAlive(true);
        pendingCall = call;

        try {
            serverSocket = new ServerSocket(port);
            serverSocket.setSoTimeout(TIMEOUT_SECONDS * 1000);
        } catch (IOException e) {
            pendingCall = null;
            call.setKeepAlive(false);
            call.reject("Failed to start server: " + e.getMessage());
            return;
        }

        timeoutFuture = scheduler.schedule(() -> {
            closeServer();
            if (pendingCall != null) {
                pendingCall.reject("Timeout waiting for connection");
                pendingCall = null;
            }
        }, TIMEOUT_SECONDS, TimeUnit.SECONDS);

        new Thread(() -> {
            try {
                Socket client = serverSocket.accept();
                handleClient(client, token);
            } catch (SocketTimeoutException e) {
                // timeout handled by scheduler
            } catch (IOException e) {
                synchronized (SettingsTransferPlugin.this) {
                    if (pendingCall != null) {
                        pendingCall.reject("Server error: " + e.getMessage());
                        pendingCall = null;
                    }
                }
            } finally {
                closeServer();
            }
        }).start();
    }

    private void handleClient(Socket client, String expectedToken) {
        try {
            client.setSoTimeout(10000);
            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream()));
            OutputStream out = client.getOutputStream();

            // Read request line
            String requestLine = reader.readLine();
            if (requestLine == null) {
                sendResponse(out, 400, "Bad Request");
                return;
            }

            // Parse method and path
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                sendResponse(out, 400, "Bad Request");
                return;
            }

            String method = parts[0];
            String path = parts[1];

            // Handle CORS preflight
            if ("OPTIONS".equals(method)) {
                sendCorsResponse(out);
                // After preflight, accept another connection for the actual POST
                client.close();
                try {
                    Socket postClient = serverSocket.accept();
                    handleClient(postClient, expectedToken);
                } catch (IOException e) {
                    // ignore
                }
                return;
            }

            if (!"POST".equals(method)) {
                sendResponse(out, 405, "Method Not Allowed");
                return;
            }

            // Validate token in path
            if (!expectedToken.isEmpty() && !path.contains("token=" + expectedToken)) {
                sendResponse(out, 403, "Forbidden");
                return;
            }

            // Read headers to find Content-Length
            int contentLength = 0;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("content-length:")) {
                    contentLength = Integer.parseInt(line.substring(15).trim());
                }
            }

            // Read body
            char[] body = new char[contentLength];
            int read = 0;
            while (read < contentLength) {
                int r = reader.read(body, read, contentLength - read);
                if (r == -1) break;
                read += r;
            }
            String bodyStr = new String(body, 0, read);

            // Send success response with CORS headers
            String responseBody = "{\"ok\":true}";
            String response = "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: application/json\r\n" +
                    "Content-Length: " + responseBody.length() + "\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Access-Control-Allow-Methods: POST, OPTIONS\r\n" +
                    "Access-Control-Allow-Headers: Content-Type\r\n" +
                    "Connection: close\r\n" +
                    "\r\n" +
                    responseBody;
            out.write(response.getBytes("UTF-8"));
            out.flush();
            client.close();

            // Resolve the pending call with received data
            synchronized (this) {
                if (pendingCall != null) {
                    if (timeoutFuture != null) {
                        timeoutFuture.cancel(false);
                    }
                    JSObject result = new JSObject();
                    result.put("data", bodyStr);
                    pendingCall.resolve(result);
                    pendingCall = null;
                }
            }
        } catch (IOException e) {
            synchronized (this) {
                if (pendingCall != null) {
                    pendingCall.reject("Error handling client: " + e.getMessage());
                    pendingCall = null;
                }
            }
        }
    }

    private void sendResponse(OutputStream out, int code, String message) throws IOException {
        String body = "{\"error\":\"" + message + "\"}";
        String response = "HTTP/1.1 " + code + " " + message + "\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: " + body.length() + "\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n" +
                "\r\n" +
                body;
        out.write(response.getBytes("UTF-8"));
        out.flush();
    }

    private void sendCorsResponse(OutputStream out) throws IOException {
        String response = "HTTP/1.1 204 No Content\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type\r\n" +
                "Access-Control-Max-Age: 86400\r\n" +
                "Connection: close\r\n" +
                "\r\n";
        out.write(response.getBytes("UTF-8"));
        out.flush();
    }

    @PluginMethod
    public synchronized void stopServer(PluginCall call) {
        closeServer();
        if (pendingCall != null) {
            pendingCall.reject("Server stopped");
            pendingCall = null;
        }
        call.resolve();
    }

    private synchronized void closeServer() {
        if (timeoutFuture != null) {
            timeoutFuture.cancel(false);
            timeoutFuture = null;
        }
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }
    }
}
