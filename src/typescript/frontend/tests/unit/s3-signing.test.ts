/**
 * @jest-environment node
 */
import { canonicalRequest, signingKey, stringToSign } from "../../src/lib/uploads/sigv4";

/**
 * AWS Signature Version 4, checked against Amazon's own published vectors.
 *
 * Signing is the one part of talking to object storage that cannot be verified by looking at it:
 * a wrong canonical request produces a valid-looking signature and a 403 that says only
 * "SignatureDoesNotMatch". The vectors below are from the AWS documentation, so a mistake here
 * fails against the reference rather than against my reading of the specification.
 */
describe("the signing key derivation", () => {
  it("matches the documented AWS vector", () => {
    // https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html
    const key = signingKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20150830",
      "us-east-1",
      "iam"
    );
    expect(key.toString("hex")).toBe(
      "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
    );
  });

  it("is derived per date, region and service, so a stale key cannot be reused", () => {
    const a = signingKey("secret", "20150830", "us-east-1", "s3");
    expect(signingKey("secret", "20150831", "us-east-1", "s3")).not.toEqual(a);
    expect(signingKey("secret", "20150830", "us-west-2", "s3")).not.toEqual(a);
    expect(signingKey("secret", "20150830", "us-east-1", "iam")).not.toEqual(a);
  });
});

describe("the canonical request", () => {
  /** The documented GET vector, whose canonical form and hash AWS publishes. */
  it("matches the documented AWS vector", () => {
    const { canonical, signedHeaders } = canonicalRequest({
      method: "GET",
      path: "/",
      query: "Action=ListUsers&Version=2010-05-08",
      headers: {
        host: "iam.amazonaws.com",
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        "x-amz-date": "20150830T123600Z",
      },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(signedHeaders).toBe("content-type;host;x-amz-date");
    expect(canonical).toBe(
      [
        "GET",
        "/",
        "Action=ListUsers&Version=2010-05-08",
        "content-type:application/x-www-form-urlencoded; charset=utf-8",
        "host:iam.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "content-type;host;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n")
    );
  });

  it("sorts and lowercases headers, because the order is part of the signature", () => {
    const { canonical, signedHeaders } = canonicalRequest({
      method: "PUT",
      path: "/key",
      query: "",
      headers: { "X-Amz-Date": "d", Host: "h", "Content-Type": "image/webp" },
      payloadHash: "abc",
    });
    expect(signedHeaders).toBe("content-type;host;x-amz-date");
    expect(canonical.split("\n")[3]).toBe("content-type:image/webp");
  });

  it("percent-encodes a path segment, so a key with a space cannot break the request line", () => {
    const { canonical } = canonicalRequest({
      method: "GET",
      path: "/a b/c+d",
      query: "",
      headers: { host: "h" },
      payloadHash: "abc",
    });
    expect(canonical.split("\n")[1]).toBe("/a%20b/c%2Bd");
  });
});

describe("the string to sign", () => {
  it("matches the documented AWS vector", () => {
    expect(
      stringToSign({
        amzDate: "20150830T123600Z",
        scope: "20150830/us-east-1/iam/aws4_request",
        canonical: [
          "GET",
          "/",
          "Action=ListUsers&Version=2010-05-08",
          "content-type:application/x-www-form-urlencoded; charset=utf-8",
          "host:iam.amazonaws.com",
          "x-amz-date:20150830T123600Z",
          "",
          "content-type;host;x-amz-date",
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ].join("\n"),
      })
    ).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/iam/aws4_request",
        "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
      ].join("\n")
    );
  });
});
