'use strict';

// Pure parser for the Proxmox auto-discovery output, extracted from server.js's
// discoverProxmox() so the parsing/cross-referencing logic can be unit-tested
// without SSH. server.js runs the remote script over SSH and passes the raw
// stdout here.
//
// The remote script emits prefixed, newline-separated lines:
//   kvm=<vmid>|<status>|<name>      one per KVM VM
//   lxc=<vmid>|<status>|<name>      one per LXC container
//   kvmnet=<vmid>|<netN: ...>       a NIC config line of a KVM VM
//   lxcnet=<vmid>|<netN: ...>       a NIC config line of an LXC container
//   neigh=<ip>|<mac>                an ARP-cache entry on the Proxmox node
//
// Returns an array of { vmid, type, name, status, macs, ip } sorted by vmid.
// IP resolution: LXC containers often hard-code ip= in their config (used
// directly); otherwise the first MAC found in the node's ARP cache wins.
function parseProxmoxDiscovery(stdout) {
  const vms = new Map();
  const arpByMac = new Map();
  const macRe = /[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}/;
  const ipRe  = /(?:^|[ ,])ip=([\d.]+)(?:\/\d+)?/;

  for (const line of (stdout || '').split('\n')) {
    let m;
    if ((m = line.match(/^kvm=(\d+)\|([^|]*)\|(.*)$/))) {
      vms.set(m[1], { vmid: parseInt(m[1], 10), type: 'kvm', status: m[2].trim(), name: m[3].trim(), macs: [], ip: null });
    } else if ((m = line.match(/^lxc=(\d+)\|([^|]*)\|(.*)$/))) {
      vms.set(m[1], { vmid: parseInt(m[1], 10), type: 'lxc', status: m[2].trim(), name: m[3].trim(), macs: [], ip: null });
    } else if ((m = line.match(/^kvmnet=(\d+)\|(.*)$/))) {
      const v = vms.get(m[1]);
      if (v) {
        const mm = m[2].match(macRe);
        if (mm) v.macs.push(mm[0].toLowerCase());
      }
    } else if ((m = line.match(/^lxcnet=(\d+)\|(.*)$/))) {
      const v = vms.get(m[1]);
      if (v) {
        const mm = m[2].match(macRe);
        if (mm) v.macs.push(mm[0].toLowerCase());
        // LXC containers often hard-code their IP in `pct config`, so use it
        // directly without falling back to the ARP cross-reference.
        if (!v.ip) {
          const im = m[2].match(ipRe);
          if (im) v.ip = im[1];
        }
      }
    } else if ((m = line.match(/^neigh=([\d.]+)\|([0-9a-f:]{17})$/))) {
      arpByMac.set(m[2], m[1]);
    }
  }

  // Cross-reference: for any VM still missing an IP, pick the first MAC that
  // appears in the Proxmox node's ARP cache.
  for (const v of vms.values()) {
    if (v.ip) continue;
    for (const mac of v.macs) {
      if (arpByMac.has(mac)) { v.ip = arpByMac.get(mac); break; }
    }
  }

  return Array.from(vms.values()).sort((a, b) => a.vmid - b.vmid);
}

module.exports = { parseProxmoxDiscovery };
