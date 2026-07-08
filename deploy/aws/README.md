# AWS deployment — Terraform + Ansible

Deploys didactic-dashboard on a single hardened EC2 VM. The pipeline, in words:

**Terraform** (VM, security group, key pair) → **EC2 Debian 13** (t3.micro, eu-south-2) → **Ansible hardening** (admin user → SSH hardening → UFW → fail2ban → unattended upgrades, roles from [debian-hardening-ansible](https://github.com/DannyRuizB/debian-hardening-ansible)) → **Docker container** (`dannyruizb/didactic-dashboard:0.6.0`, published `80:3000`, SQLite on a named volume).

Port 22 is open only to your IP; port 80 is public — that is the dashboard.

## Prerequisites

- An **AWS account** with credentials configured locally (`aws configure`).
- **eu-south-2 enabled on the account.** The default region here is Spain, which is *opt-in*: fresh accounts have it disabled, and `terraform apply` fails with a confusing credentials error. Enable it with `aws account enable-region --region-name eu-south-2` (or console → Account → Regions) and wait a few minutes until it reports `ENABLED` — or deploy to an always-on region instead: `terraform apply -var aws_region=eu-west-1 ...`.
- An **SSH keypair** at `~/.ssh/id_ed25519` / `id_ed25519.pub` (`ssh-keygen -t ed25519` if you don't have one). Terraform uploads the public key; Ansible connects with the private one.
- Three CLIs on your machine: `terraform` (>= 1.5), `ansible` (provides `ansible-playbook` and `ansible-galaxy`) and `aws`. Plus `git` and `curl`, which the script also checks.

## Usage

```bash
cd deploy/aws
./deploy.sh
```

The script checks your tools and credentials, creates the VM, waits for SSH, generates the Ansible inventory from the Terraform output, vendors the hardening roles, runs the playbook and prints the app URL and SSH command.

### Manual equivalent, step by step

```bash
# 1. Create the VM (SSH restricted to your current public IP)
cd terraform
terraform init
terraform apply -var "admin_cidr=$(curl -s ifconfig.me)/32"
terraform output        # public_ip, ssh_command, app_url

# 2. Point Ansible at the new instance
cd ../ansible
cp inventory.example.ini inventory.ini    # replace the placeholder IP

# 3. Vendor the hardening roles + install the collections locally
#    (deploy.sh pins the clone to a known commit — see HARDENING_REF there)
git clone https://github.com/DannyRuizB/debian-hardening-ansible vendor/debian-hardening-ansible
ansible-galaxy collection install -r requirements.yml -p ./collections

# 4. Harden the host and start the container
ansible-playbook site.yml
```

## Cost

In eu-south-2 (verified against AWS's official price list CSV, effective 2026-07-01): t3.micro on-demand $0.0114/h x 730 h = $8.32 + 20 GB gp3 x $0.088/GB-mo = $1.76 + public IPv4 $0.005/h x 730 h = $3.65 => ~$13.7/month (~$13.75, before minor data-transfer costs). CPU credits are set to `standard` (see `main.tf`), so sustained load throttles instead of billing surcharges — that figure is the ceiling. The $100 signup credit alone covers ~7.3 months of this, i.e. more than the entire 6-month free-plan window (total 6-month spend ~$82); with the full $200 in credits on a paid plan it would stretch to ~14.5 months (subject to credit expiry).

**New-account free credits.** Accounts created after 2025-07-15 get the credits-based Free Tier: USD $100 in credits at signup (regardless of plan) plus up to $100 more earned via activities in the console's "Explore AWS" widget ($20 per activity with EC2, RDS, Lambda, Bedrock, and AWS Budgets, to be completed within 6 months) — up to $200 total. On the "free account plan" you incur no charges at all; the plan ends after 6 months OR when credits are exhausted, whichever comes first (some credit-hungry services are blocked). When it ends, AWS closes the account and you lose access to resources; data is retained 90 days, during which you can upgrade to the paid plan to restore access — otherwise the account and all content are permanently deleted. On the "paid account plan", once credits run out you simply pay standard on-demand pricing.

## Teardown

```bash
./deploy.sh destroy
```

Terraform shows the plan and asks for confirmation before deleting anything. The SQLite data lives on the VM's Docker volume, so it goes away with the instance.

## Design decisions

- **No Terraform modules** — one VM, flat files. Easier to read than a module tree.
- **No Elastic IP** — one less billed resource; the auto-assigned public IP changes on stop/start, so re-run `terraform output` after restarting the instance.
- **`pathexpand()` on the key path** — Terraform's `file()` does not expand `~`.
- **Port 22 only from `admin_cidr`** (no default: you must state who gets SSH), port 80 open to the world — it's the app.
- **Default VPC on purpose** — a custom VPC would add nothing to a one-VM demo.
- **Official Debian 13 AMI** (owner `136693071363`); its default user is `admin`. The name filter excludes Debian's untested `daily-*` builds, and `ignore_changes = [ami]` stops a newer AMI from replacing the instance on re-runs — replacement destroys the root volume and with it the SQLite data. Upgrading the AMI is a deliberate `terraform apply -replace=aws_instance.dashboard`.
- **Hardening roles vendored with git, not Galaxy** — the repo has no Galaxy metadata, so `ansible.cfg` adds the clone to `roles_path`. The checkout is pinned to a commit (`HARDENING_REF` in deploy.sh): these roles run as root, so upgrades are deliberate, like `app_tag`.
- **Role order matters**: `admin_user` runs before `ssh_hardening` so the lockout guard finds an installed key; `ansible_user` is set in the inventory (not `-u`) because that guard checks `{{ ansible_user }}`'s authorized_keys.
- **SSH stays on port 22** — moving it mid-run creates a lockout window; the security group + fail2ban already protect it.
- **UFW rule for 80/tcp is intent documentation** — Docker's iptables rules bypass UFW for published ports; the security group is the real perimeter.
- **Image tag pinned to `0.6.0`**, not `:latest` — upgrades are deliberate, reproducible actions.
- **Host key checking disabled** (`ansible.cfg`, deploy.sh) — the VM's host key is new on every deploy; do not carry this setting onto long-lived infra.
