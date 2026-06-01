'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseProxmoxDiscovery } = require('../src/discovery');

test('parses KVM + LXC, resolves IPs via ARP and direct config', () => {
  const stdout = [
    'kvm=100|running|web-server',
    'kvm=101|stopped|db-server',
    'lxc=200|running|proxy',
    'kvmnet=100|net0: virtio=AA:BB:CC:DD:EE:01,bridge=vmbr0',
    'kvmnet=101|net0: virtio=AA:BB:CC:DD:EE:02,bridge=vmbr0',
    'lxcnet=200|net0: name=eth0,bridge=vmbr0,hwaddr=AA:BB:CC:DD:EE:03,ip=10.0.0.50/24',
    'neigh=10.0.0.10|aa:bb:cc:dd:ee:01',
  ].join('\n');

  const vms = parseProxmoxDiscovery(stdout);
  assert.equal(vms.length, 3);

  // KVM 100: IP resolved from the ARP cache via its MAC (lowercased)
  assert.deepEqual(vms[0], {
    vmid: 100, type: 'kvm', status: 'running', name: 'web-server',
    macs: ['aa:bb:cc:dd:ee:01'], ip: '10.0.0.10',
  });

  // KVM 101: MAC not in ARP cache -> no IP
  assert.equal(vms[1].vmid, 101);
  assert.equal(vms[1].status, 'stopped');
  assert.equal(vms[1].ip, null);

  // LXC 200: IP comes straight from pct config (ip=...), ARP not needed
  assert.equal(vms[2].vmid, 200);
  assert.equal(vms[2].type, 'lxc');
  assert.equal(vms[2].ip, '10.0.0.50');
  assert.deepEqual(vms[2].macs, ['aa:bb:cc:dd:ee:03']);
});

test('result is sorted by vmid regardless of input order', () => {
  const stdout = [
    'kvm=300|running|c',
    'kvm=100|running|a',
    'lxc=200|running|b',
  ].join('\n');
  assert.deepEqual(parseProxmoxDiscovery(stdout).map((v) => v.vmid), [100, 200, 300]);
});

test('direct LXC ip wins over a conflicting ARP entry', () => {
  const stdout = [
    'lxc=200|running|proxy',
    'lxcnet=200|net0: hwaddr=AA:BB:CC:DD:EE:03,ip=10.0.0.50/24',
    'neigh=10.0.0.99|aa:bb:cc:dd:ee:03',
  ].join('\n');
  assert.equal(parseProxmoxDiscovery(stdout)[0].ip, '10.0.0.50');
});

test('multiple NICs: first MAC found in ARP wins', () => {
  const stdout = [
    'kvm=100|running|multi',
    'kvmnet=100|net0: virtio=AA:BB:CC:DD:EE:01,bridge=vmbr0',
    'kvmnet=100|net1: virtio=AA:BB:CC:DD:EE:02,bridge=vmbr1',
    'neigh=10.0.0.20|aa:bb:cc:dd:ee:02',
  ].join('\n');
  const vm = parseProxmoxDiscovery(stdout)[0];
  assert.deepEqual(vm.macs, ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02']);
  assert.equal(vm.ip, '10.0.0.20'); // matched the second NIC
});

test('net lines for unknown vmid are ignored (no crash)', () => {
  const stdout = [
    'kvm=100|running|web',
    'kvmnet=999|net0: virtio=AA:BB:CC:DD:EE:09,bridge=vmbr0', // no such VM
  ].join('\n');
  const vms = parseProxmoxDiscovery(stdout);
  assert.equal(vms.length, 1);
  assert.deepEqual(vms[0].macs, []);
});

test('blank, malformed and unknown-prefix lines are skipped', () => {
  const stdout = [
    '',
    'garbage line',
    'kvm=100|running|web',
    '   ',
    'foo=bar|baz',
  ].join('\n');
  const vms = parseProxmoxDiscovery(stdout);
  assert.equal(vms.length, 1);
  assert.equal(vms[0].vmid, 100);
});

test('empty / nullish input returns an empty array', () => {
  assert.deepEqual(parseProxmoxDiscovery(''), []);
  assert.deepEqual(parseProxmoxDiscovery(undefined), []);
});

test('a VM with no NICs at all has empty macs and null ip', () => {
  const vms = parseProxmoxDiscovery('lxc=201|running|lonely');
  assert.deepEqual(vms[0].macs, []);
  assert.equal(vms[0].ip, null);
});
