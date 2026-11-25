import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAttachmentPayload } from "./attachment-payload.js";

afterEach(() => vi.unstubAllGlobals());

describe("existing hosted URL receipt uploads", () => {
  it("fetches a receipt URL and infers the type and advertised name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("%PDF-1.4 receipt", {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=receipt.pdf",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = await buildAttachmentPayload({ url: "https://files.example/download?id=123" });
    expect(payload.file_name).toBe("receipt.pdf");
    expect(payload.content_type).toBe("application/pdf");
    expect(Buffer.from(payload.data, "base64").toString()).toBe("%PDF-1.4 receipt");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["http://files.example/receipt.pdf", "https://127.0.0.1/receipt.pdf"])(
    "refuses an unsupported receipt URL %s before fetching", async (url) => {
      const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
      await expect(buildAttachmentPayload({ url })).rejects.toThrow(/https|not allowed/);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("does not silently choose between a URL and another receipt source", async () => {
    await expect(buildAttachmentPayload({ url: "https://files.example/r.pdf", upload_id: "token" }))
      .rejects.toThrow(/exactly one/);
  });
});
