variable "aws_region" {
  description = <<-EOT
    AWS region to deploy into. eu-south-2 (Spain) keeps latency low from here,
    but it is an OPT-IN region: enable it first on a fresh account (see
    README.md, Prerequisites) or override with an always-on region like eu-west-1.
  EOT
  type        = string
  default     = "eu-south-2"
}

variable "instance_type" {
  description = "EC2 instance type. t3.micro (2 vCPU, 1 GiB) is plenty for this app."
  type        = string
  default     = "t3.micro"
}

variable "ssh_public_key_path" {
  description = "Path to the SSH public key uploaded as the EC2 key pair."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "admin_cidr" {
  description = <<-EOT
    CIDR allowed to SSH into the VM. No default on purpose: never expose port 22
    to the whole internet. To allow only your current IP, pass:
      terraform apply -var "admin_cidr=$(curl -s ifconfig.me)/32"
  EOT
  type        = string
}

variable "project_name" {
  description = "Name used for tagging and resource names."
  type        = string
  default     = "didactic-dashboard"
}
