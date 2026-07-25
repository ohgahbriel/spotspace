# Deploying SpotSpace to Oracle Cloud (Always Free)

This gets SpotSpace running on a real, persistent VM — uploaded songs and
accounts live on the VM's disk and survive restarts/reboots (unlike most
free PaaS hosts, which wipe local files on every redeploy).

Access will be **plain HTTP** over the VM's public IP (no domain set up
yet), so treat it as suitable for a small trusted group rather than the
open internet — logins aren't encrypted in transit until you add a domain
+ HTTPS later (see "Adding HTTPS later" at the bottom; nothing here needs
to be redone to add it).

## 1. Create the Oracle Cloud account + VM

This part only you can do (needs your own account/identity verification):

1. Sign up at oracle.com/cloud/free — the "Always Free" resources don't
   expire and don't get billed, but Oracle does ask for a credit card
   during signup for identity verification.
2. In the Console, create a **Compute Instance**:
   - Shape: an "Always Free" eligible shape (an Ampere A1 flex instance,
     or a VM.Standard.E2.1.Micro) — the console labels which shapes are
     free-tier eligible.
   - Image: **Ubuntu** (simplest — this script assumes `apt`).
   - Generate/download an SSH key pair when prompted (or upload your own
     public key) — you'll need the private key to connect.
3. Note the instance's **public IP address** once it's running.

## 2. Open the port in Oracle's cloud firewall

Oracle has *two* firewall layers — both must allow the port, or nothing
connects even if the VM's own firewall is wide open:

1. In the Console, go to your instance's **Subnet → Security List** (or
   **Network Security Group** if you attached one).
2. Add an **Ingress Rule**: source `0.0.0.0/0`, protocol TCP, destination
   port `5075` (or whatever port you plan to run on).

## 3. Get the code onto the VM

SSH in first:
```
ssh -i /path/to/your-private-key ubuntu@<vm-public-ip>
```

Then, on the VM, get SpotSpace into `/opt/spotspace`:
```
sudo mkdir -p /opt/spotspace
sudo chown ubuntu:ubuntu /opt/spotspace
git clone https://github.com/ohgahbriel/spotspace.git /opt/spotspace
```
Or, without git, copy it from your machine instead (run this on your own
machine, not the VM):
```
scp -i /path/to/your-private-key -r "C:\Users\User\VS Code\spotspace\*" ubuntu@<vm-public-ip>:/opt/spotspace/
```

## 4. Run the setup script

Back on the VM:
```
cd /opt/spotspace
sudo bash deploy/setup-oracle-vm.sh 5075
```
This installs Node.js if needed, creates a dedicated non-root `spotspace`
user to run the app, opens the port in the VM's own OS firewall, and
installs + starts it as a systemd service (auto-restarts on crash, starts
on boot).

Visit `http://<vm-public-ip>:5075` — you should see SpotSpace.

## Operating it

- **Logs**: `journalctl -u spotspace -f`
- **Restart**: `sudo systemctl restart spotspace`
- **Update after a code change**: `cd /opt/spotspace && git pull && sudo systemctl restart spotspace`
- **Back up your data**: everything — accounts, songs, comments — lives in
  `/opt/spotspace/library/`. That's the one folder actually worth backing
  up; the rest is just code you can always re-pull.

## Adding HTTPS later

Once you have a domain pointed at the VM's IP, put a reverse proxy
(Caddy is the simplest — it gets you free automatic HTTPS with a ~5-line
config) in front of port 5075, then set `COOKIE_SECURE=true` in
`spotspace.service` and restart. No other changes needed.
