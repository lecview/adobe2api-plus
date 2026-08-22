import { parseProxyUrl } from "@/lib/proxy-pool";

describe("proxy parsing", () => {
  it("accepts HTTP and SOCKS5 credentials", () => {
    expect(parseProxyUrl("http://user:pass@example.com:8080")).toMatchObject({ protocol: "HTTP", host: "example.com", port: 8080, username: "user", password: "pass" });
    expect(parseProxyUrl("socks5://example.com:1080")).toMatchObject({ protocol: "SOCKS5", port: 1080 });
  });

  it("rejects path-bearing or malformed proxy URLs", () => {
    expect(() => parseProxyUrl("http://example.com:8080/path")).toThrowError(/URL path/);
    expect(() => parseProxyUrl("http://user%ZZ@example.com:8080")).toThrowError(/invalid URL encoding/);
  });

  it("accepts the host:port:user:pass ordering used by providers like hideip", () => {
    expect(parseProxyUrl("http://example.com:5050:user:pass")).toMatchObject({ protocol: "HTTP", host: "example.com", port: 5050, username: "user", password: "pass" });
    expect(parseProxyUrl("example.com:5050:user:pass")).toMatchObject({ protocol: "HTTP", host: "example.com", port: 5050, username: "user", password: "pass" });
    expect(parseProxyUrl("socks5://example.com:5050:user:pass")).toMatchObject({ protocol: "SOCKS5", host: "example.com", port: 5050, username: "user", password: "pass" });
    expect(parseProxyUrl("http://proxy.hideiqxshlgvjk.com:5050:ceshi005-type-residential:ceshi003")).toMatchObject({ protocol: "HTTP", host: "proxy.hideiqxshlgvjk.com", port: 5050, username: "ceshi005-type-residential", password: "ceshi003" });
  });

  it("still rejects host:port:user:pass with an out-of-range port", () => {
    // 99999 在 URL 解析层即被拒（超 65535），0 走端口范围检查，均返回 invalid_proxy。
    expect(() => parseProxyUrl("example.com:99999:user:pass")).toThrowError(/invalid|between 1 and 65535/);
    expect(() => parseProxyUrl("example.com:0:user:pass")).toThrowError(/between 1 and 65535/);
  });
});
