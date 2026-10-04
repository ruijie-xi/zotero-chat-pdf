import { expect, it, vi } from "vitest";
import { getAllCollections } from "../src/modules/zotero-items";
it("enumerates empty nested collections without relying on item memberships", async () => {
  vi.mocked(Zotero.Libraries.getAll).mockReturnValue([{ libraryID: 1 }] as any);
  const getByLibrary = vi.fn(() => [{ libraryID: 1, key: "EMPTY001", name: "Empty child", parentKey: "PARENT01", getChildItems: () => [] },
    { libraryID: 1, key: "TRASH001", name: "Deleted", deleted: true }]);
  Object.assign(Zotero, { Collections: { getByLibrary } });
  expect(await getAllCollections()).toMatchObject([{ key: "EMPTY001", name: "Empty child", parentKey: "PARENT01", itemCount: 0 }]);
  expect(getByLibrary).toHaveBeenCalledWith(1, true, false);
});
