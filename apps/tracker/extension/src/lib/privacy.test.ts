import { describe, expect, test } from "vite-plus/test";

import { isPrivateHost, privateUrl } from "./privacy.ts";

describe("isPrivateHost", () => {
  const hosts = ["bank.example", " Mail.Example.com ", "*.internal"];

  test("matches the host and its subdomains", () => {
    expect(isPrivateHost("bank.example", hosts)).toBe(true);
    expect(isPrivateHost("login.bank.example", hosts)).toBe(true);
    expect(isPrivateHost("mail.example.com", hosts)).toBe(true);
    expect(isPrivateHost("wiki.internal", hosts)).toBe(true);
  });

  test("reads entries pasted as URLs, with ports or as Unicode", () => {
    const pasted = [
      "https://mail.google.com/mail/u/0/",
      "bank.example/",
      "localhost:3000",
      "bücher.de",
    ];
    expect(isPrivateHost("mail.google.com", pasted)).toBe(true);
    expect(isPrivateHost("online.bank.example", pasted)).toBe(true);
    expect(isPrivateHost("localhost", pasted)).toBe(true);
    expect(isPrivateHost("xn--bcher-kva.de", pasted)).toBe(true);
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
