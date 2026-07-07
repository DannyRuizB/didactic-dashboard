# Newest official Debian 13 (trixie) AMI, published by Debian (account 136693071363).
data "aws_ami" "debian_13" {
  most_recent = true
  owners      = ["136693071363"]

  filter {
    # Release images are named debian-13-amd64-<YYYYMMDD>-<build>. The "20"
    # prefix excludes the untested debian-13-amd64-daily-* builds, which the
    # same account publishes and which would otherwise always win most_recent.
    name   = "name"
    values = ["debian-13-amd64-20*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

data "aws_vpc" "default" {
  default = true
}

resource "aws_key_pair" "admin" {
  key_name   = "${var.project_name}-key"
  public_key = file(pathexpand(var.ssh_public_key_path)) # pathexpand resolves the "~"
}

resource "aws_security_group" "dashboard" {
  name        = "${var.project_name}-sg"
  description = "SSH from admin IP only, HTTP from anywhere"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH (restricted to the operator's IP)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  ingress {
    description = "HTTP (the dashboard is public on port 80)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow all outbound (Docker Hub pulls, apt, health probes)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-sg"
    Project = var.project_name
  }
}

resource "aws_instance" "dashboard" {
  ami                    = data.aws_ami.debian_13.id
  instance_type          = var.instance_type
  key_name               = aws_key_pair.admin.key_name
  vpc_security_group_ids = [aws_security_group.dashboard.id]

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  # t3 defaults to "unlimited" CPU credits: sustained CPU above the ~10%
  # baseline is billed as a surcharge. "standard" throttles instead — the
  # worst case is a slow dashboard, never a surprise bill.
  credit_specification {
    cpu_credits = "standard"
  }

  # No Elastic IP on purpose (one less billed resource): the auto-assigned
  # public IP is fine for a demo, but it CHANGES on stop/start —
  # re-run `terraform output` after restarting the instance.

  # A newer Debian AMI must never replace a running instance: the SQLite data
  # lives on the root volume and would be destroyed with it. To upgrade the
  # AMI on purpose: terraform apply -replace=aws_instance.dashboard
  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name    = var.project_name
    Project = var.project_name
  }
}
