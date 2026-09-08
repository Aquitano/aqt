import { describe, expect, test } from "bun:test";

import { isPrivateHost, privateUrl } from "./privacy.ts";

describe("isPrivateHost", () => {
  const hosts = ["bank.example", " Mail.Example.com ", "*.internal"];

  test("matches the host and its subdomains", () => {
    expect(isPrivateHost("bank.example", hosts)).toBe(true);
    expect(isPrivateHost("login.bank.example", hosts)).toBe(true);
    expect(isPrivateHost("mail.example.com", hosts)).toBe(true);
    expect(isPrivateHost("wiki.internal", hosts)).toBe(true);
  });

  test("does not match lookalikes or blank entries", () => {
    expect(isPrivateHost("notbank.example", hosts)).toBe(false);
    expect(isPrivateHost("example.com", hosts)).toBe(false);
    expect(isPrivateHost("anything", ["", "  "])).toBe(false);
  });
});

describe("privateUrl", () => {
  test("keeps only the host", () => {
    expect(privateUrl(new URL("http://bank.example:8080/accounts/42?x=1#y"))).toBe(
      "https://bank.example/",
    );
  });
});
