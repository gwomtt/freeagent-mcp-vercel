import path from "node:path";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const ACCEPTED_CONTENT_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif"]);

/**
 * Identify a file from its leading bytes.
 *
 * Needed because plenty of hosts serve a correct file under a useless content
 * type. Google Drive's download endpoint, for one, returns
 * application/octet-stream for everything.
 */
export function sniffContentType(bytes: Buffer): string | undefined {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  return undefined;
}

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

export interface ReadAttachmentFileResult {
  data: string;
  file_name: string;
  content_type: string;
  bytes: number;
}

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /\.internal$/i,
  /^metadata\./i,
];

/**
 * Download an attachment from an HTTPS URL.
 *
 * The server does the fetching, so a client can hand over a link rather than
 * megabytes of base64. Because the server performs the request, the URL is
 * constrained: HTTPS only, no loopback, private or link-local hosts, and the
 * response is size- and type-checked before use.
 */
export async function readAttachmentUrl(rawUrl: string): Promise<ReadAttachmentFileResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Attachment url '${rawUrl}' is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Attachment url must use https, got '${parsed.protocol.replace(":", "")}'.`);
  }
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    throw new Error(`Attachment url host '${parsed.hostname}' is not allowed (loopback, private or link-local address).`);
  }

  const response = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Could not download attachment: ${response.status} ${response.statusText} from ${parsed.host}.`);
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment at ${parsed.host} is ${(declaredLength / 1048576).toFixed(1)}MB, over FreeAgent's 5MB limit.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment at ${parsed.host} is ${(buffer.byteLength / 1048576).toFixed(1)}MB, over FreeAgent's 5MB limit.`);
  }
  if (buffer.byteLength === 0) {
    throw new Error(`Attachment at ${parsed.host} was empty. If this is a sharing link, check the file is readable by anyone with the link.`);
  }

  const headerType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();

  // Prefer the name the server advertises. A Drive download URL is
  // /uc?export=download&id=..., whose path carries no usable file name.
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  const advertised = encoded ? decodeURIComponent(encoded[1]) : plain ? plain[1] : "";
  const fromPath = path.basename(parsed.pathname);

  // Trust, in order: an accepted content type from the server, the file's own
  // leading bytes, then an extension from the advertised or url file name.
  const contentType =
    (ACCEPTED_CONTENT_TYPES.has(headerType) ? headerType : undefined) ??
    sniffContentType(buffer) ??
    EXTENSION_CONTENT_TYPES[path.extname(advertised || fromPath || "").toLowerCase()];

  if (!contentType) {
    throw new Error(
      `Attachment from ${parsed.host} is not a file FreeAgent accepts. It was served as ` +
      `'${headerType || "an unknown type"}' and its contents do not look like a PDF, PNG, JPEG or GIF. ` +
      `If this is a Drive link, use the direct download form ` +
      `(https://drive.google.com/uc?export=download&id=FILE_ID) rather than the preview page, ` +
      `and check the file is readable by anyone with the link.`
    );
  }

  const fileName =
    (advertised && path.extname(advertised) ? path.basename(advertised) : "") ||
    (fromPath && path.extname(fromPath) ? fromPath : "") ||
    `attachment.${contentType.split("/")[1].replace("jpeg", "jpg")}`;

  return { data: buffer.toString("base64"), file_name: fileName, content_type: contentType, bytes: buffer.byteLength };
}

