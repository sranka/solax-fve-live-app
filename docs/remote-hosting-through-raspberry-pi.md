# Remote Hosting on Raspberry Pi

Run the Solax FVE Monitor on a Raspberry Pi on the same network as the inverter and access it remotely via a Cloudflare Tunnel.

## Prerequisites

- Raspberry Pi (3/4/5 recommended) running **Raspberry Pi OS** (based on Debian Trixie) with Desktop
- Solax inverter reachable from the Pi's local network
- Cloudflare account (free tier) with a registered domain
- SSH access to the Pi

## 1. Install Node.js

Raspberry Pi OS (Debian Trixie) includes Node.js in the default repositories:

```bash
sudo apt-get update
sudo apt-get install -y nodejs
```

Verify the installation:

```bash
node --version   # v22.x.x
```

## 2. Deploy the Application

### Option A: Copy from your development machine

From the machine where you have the repository checked out:

```bash
PI_HOST=pi@raspberrypi.local

tar czf /tmp/solax-fve.tar.gz scripts/dev-server.js scripts/stamp-build.sh scripts/service/ web/ package.json
scp /tmp/solax-fve.tar.gz $PI_HOST:/tmp/

ssh $PI_HOST "sudo mkdir -p /opt/solax-fve && \
  sudo tar xzf /tmp/solax-fve.tar.gz -C /opt/solax-fve && \
  rm /tmp/solax-fve.tar.gz"
```

### Option B: Clone the repository on the Pi

```bash
sudo apt-get install -y git
git clone https://github.com/sranka/solax-fve-realtime-app.git /tmp/solax-fve-src
```

Then run the install script (see next section).

### Test manually

```bash
cd /tmp/solax-fve-src
sudo sh scripts/stamp-build.sh
MODBUS=0 PROXY_TARGET=http://<INVERTER_IP> node scripts/dev-server.js
```

Open `http://<PI_IP>:8080` in a browser to verify the app works.

## 3. Install as a systemd Service

The install script handles creating the system user, copying files, and setting up the service:

```bash
cd /tmp/solax-fve-src   # or wherever the repository is
sudo bash scripts/service/rpi-install.sh
```

This will:
- Create a `solax` system user
- Copy application files to `/opt/solax-fve`
- Create `/etc/default/solax-fve` with default configuration
- Install and start the `solax-fve` systemd service

### Configure the inverter connection

Edit the environment file to match your inverter IP:

```bash
sudo nano /etc/default/solax-fve
```

```bash
PORT=8080
PROXY_TARGET=http://192.168.199.192
# MODBUS_TARGET=192.168.199.192:502
MODBUS=1
```

Restart after changes:

```bash
sudo systemctl restart solax-fve
```

### Service commands

```bash
sudo systemctl status solax-fve     # check status
sudo systemctl restart solax-fve    # restart
sudo systemctl stop solax-fve       # stop
journalctl -u solax-fve -f          # follow logs
```

## 4. Configure Cloudflare Tunnel

Cloudflare Tunnel exposes the app to the internet without port forwarding.

> Full documentation: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

### Install cloudflared

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared
```

> For 32-bit Raspberry Pi OS (armhf), use `cloudflared-linux-arm` instead of `cloudflared-linux-arm64`.

### Authenticate and create a tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create solax-fve
```

Note the **Tunnel UUID** from the output.

### Configure the tunnel

Copy the example config and fill in your values:

```bash
mkdir -p ~/.cloudflared
cp /opt/solax-fve/scripts/service/cloudflared-config-example.yml ~/.cloudflared/config.yml
nano ~/.cloudflared/config.yml
```

Replace `<TUNNEL_UUID>` with your tunnel UUID and `solax.example.com` with your actual domain.

### Add DNS route

```bash
cloudflared tunnel route dns solax-fve solax.example.com
```

### Run as a service

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

Verify the tunnel is working by visiting `https://solax.example.com` in your browser.

## 5. Protect POST Endpoints

The POST endpoints (`/http` and `/modbus`) send commands to the inverter. You should restrict access to these endpoints to trusted IP addresses using Cloudflare WAF custom rules.

> Full documentation: https://developers.cloudflare.com/waf/custom-rules/

### Create a WAF rule to block unauthorized POST requests

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com)
2. Select your domain
3. Go to **Security** → **WAF** → **Custom rules**
4. Click **Create rule**
5. Configure the rule:
   - **Rule name:** `Block POST to Solax FVE`
   - **Expression:** use the expression builder or edit the expression directly:
     ```
     (http.request.method eq "POST") and (not ip.src in {<YOUR_HOME_IP>})
     ```
     Replace `<YOUR_HOME_IP>` with your public IP address (find it at https://whatismyipaddress.com). You can add multiple IPs: `{1.2.3.4 5.6.7.8}`.
   - **Action:** `Block`
6. Click **Deploy**

This rule blocks all POST requests to your Solax domain unless they originate from your allowed IP addresses. GET requests (the monitoring dashboard) remain accessible from anywhere.

### Dynamic IP considerations

If your home IP changes frequently, consider:
- Using a Cloudflare Access policy with email-based authentication instead of IP filtering
- Setting up a script that updates the WAF rule when your IP changes via the [Cloudflare API](https://developers.cloudflare.com/api/)

## 6. Maintenance

### Update the application

Copy new files and run the install script again — it preserves your `/etc/default/solax-fve` configuration:

```bash
cd /path/to/solax-fve-realtime-app
sudo bash scripts/service/rpi-install.sh
```

### View logs

```bash
journalctl -u solax-fve -f          # app logs
journalctl -u cloudflared -f        # tunnel logs
```

### Check tunnel status

```bash
cloudflared tunnel info solax-fve
```
