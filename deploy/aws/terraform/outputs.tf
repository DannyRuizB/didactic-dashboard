output "public_ip" {
  description = "Public IPv4 of the VM (changes on stop/start — no Elastic IP)."
  value       = aws_instance.dashboard.public_ip
}

output "ssh_command" {
  description = "Ready-to-paste SSH command ('admin' is the default user on Debian AMIs)."
  value       = "ssh admin@${aws_instance.dashboard.public_ip}"
}

output "app_url" {
  description = "Dashboard URL once the app is running on the VM."
  value       = "http://${aws_instance.dashboard.public_ip}"
}
