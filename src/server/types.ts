export interface BookmarkNode {
  id: string;
  guid: string;
  title: string;
  url: string;
  parentId: string;
  index: number;
  folderPath: string;
  dateAdded: number;
}

export interface FolderNode {
  id: string;
  guid: string;
  title: string;
  parentId: string | null;
  index: number;
  folderPath: string;
  bookmarkCount: number;
  totalCount: number;
}

export interface BookmarkIndex {
  bookmarks: BookmarkNode[];
  folders: FolderNode[];
  byId: Map<string, BookmarkNode>;
  byGuid: Map<string, BookmarkNode>;
  folderById: Map<string, FolderNode>;
  loadedAt: number;
}
