import { expect, it } from "vitest";
import { isPublicAddress } from "../src/web-address.js";

// IANA's special-purpose registries: nothing that reaches the operator's own machine or network is public.
it.each([
  "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
  "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
  "240.0.0.1", "255.255.255.255",
  "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "64:ff9b::a00:1",
  "::ffff:127.0.0.1", "::ffff:192.168.0.1", "2002:c0a8:101::1",
])("refuses %s", (address) => {
  expect(isPublicAddress(address)).toBe(false);
});

it.each(["8.8.8.8", "93.184.215.14", "172.32.0.1", "100.128.0.1", "2606:4700:10::6814:179a", "::ffff:8.8.8.8",
  "64:ff9b::808:808"])("accepts %s", (address) => {
  expect(isPublicAddress(address)).toBe(true);
});

it("refuses anything that is not an address", () => {
  expect(isPublicAddress("example.com")).toBe(false);
  expect(isPublicAddress("")).toBe(false);
});
