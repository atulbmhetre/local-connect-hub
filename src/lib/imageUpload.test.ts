import { beforeEach, describe, expect, it, vi } from "vitest";

const removeMock = vi.fn();
const uploadMock = vi.fn();
const getPublicUrlMock = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => uploadMock(...args),
        getPublicUrl: (...args: unknown[]) => getPublicUrlMock(...args),
        remove: (...args: unknown[]) => removeMock(...args),
      }),
    },
  },
}));

import { withOptionalFeedImageUpload } from "./imageUpload";

describe("withOptionalFeedImageUpload — orphan cleanup", () => {
  beforeEach(() => {
    uploadMock.mockReset();
    removeMock.mockReset();
    getPublicUrlMock.mockReset();

    uploadMock.mockResolvedValue({ error: null });
    removeMock.mockResolvedValue({ error: null });
    getPublicUrlMock.mockImplementation((path: string) => ({
      data: {
        publicUrl: `https://example.test/storage/v1/object/public/feed-images/${path}`,
      },
    }));
  });

  it("deletes the uploaded storage object when the RPC/submit fails", async () => {
    const file = new File(["img"], "offer.jpg", { type: "image/jpeg" });

    const result = await withOptionalFeedImageUpload(file, "offers", async (imageUrl) => {
      expect(imageUrl).toContain("/offers/");
      return { error: { message: "rate_limited" } };
    });

    expect(result.error).toEqual({ message: "rate_limited" });
    expect(uploadMock).toHaveBeenCalledOnce();
    expect(removeMock).toHaveBeenCalledOnce();
    const removedPaths = removeMock.mock.calls[0][0] as string[];
    expect(removedPaths).toHaveLength(1);
    expect(removedPaths[0]).toMatch(/^offers\/\d+-offer\.jpg$/);
  });

  it("keeps the storage object when submit succeeds", async () => {
    const file = new File(["img"], "a.jpg", { type: "image/jpeg" });

    const result = await withOptionalFeedImageUpload(file, "announcements", async (imageUrl) => {
      expect(imageUrl).toContain("/announcements/");
      return { data: { id: "post-1" }, error: null };
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ id: "post-1" });
    expect(uploadMock).toHaveBeenCalledOnce();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("still surfaces the submit error if delete also fails", async () => {
    removeMock.mockResolvedValue({ error: { message: "delete_denied" } });
    const file = new File(["img"], "a.jpg", { type: "image/jpeg" });
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await withOptionalFeedImageUpload(file, "announcements", async () => ({
      error: { message: "network" },
    }));

    expect(result.error).toEqual({ message: "network" });
    expect(removeMock).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("skips upload and cleanup when no file is provided", async () => {
    const result = await withOptionalFeedImageUpload(null, "announcements", async (imageUrl) => {
      expect(imageUrl).toBeNull();
      return { error: { message: "validation" } };
    });

    expect(result.error).toEqual({ message: "validation" });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });
});
