import FileSystem, { File, FileEvent } from "../filesystem";
import type { editor as MonacoEditorType, IDisposable } from "monaco-editor";

type ContentsChangedListener = (contents: string) => void;

type EditorState =
  | { type: "code"; editor: MonacoEditorType.IStandaloneCodeEditor }
  | { type: "diff"; editor: MonacoEditorType.IStandaloneDiffEditor }
  | { type: "none" };

export class EditorController {
  private workingFile: File | null = null;
  private committedFile: File | null = null;
  private _editor: EditorState = { type: "none" };
  private editorCleanups: IDisposable[] = []; // Track editor listener disposals

  // Three-way content split:
  private _localContents = ""; // Current editor value (user's edits)
  private _remoteContents = ""; // Latest from server (working file)
  private _committedContents = ""; // Latest committed version (@file)

  private localListeners = new Set<ContentsChangedListener>();
  private committedListeners = new Set<ContentsChangedListener>();
  private autoSaveTimeoutId: number | null = null;
  private disposed = false;

  constructor(
    private fs: FileSystem,
    private path: string,
  ) {
    this.init();
  }

  private async init() {
    try {
      // Open both working and committed versions
      this.workingFile = this.fs.openFile(this.path);
      this.committedFile = this.fs.openFile(`@${this.path}`);

      // Start listening for events
      this.watchFile(this.workingFile, (content) => {
        console.debug("New content from working file:", content);
        this._remoteContents = content;
        // For now, simple last-wins: update local content to match remote
        // TODO: Implement proper merging algorithm
        this._localContents = content;
        console.debug("Local contents updated to:", this._localContents);

        console.debug("Editor is", this._editor);
        if (this._editor.type === "code") {
          console.debug("Updating code editor content to ", content);
          this._editor.editor.setValue(content);
        } else if (this._editor.type === "diff") {
          this._editor.editor.getModifiedEditor().setValue(content);
        }

        this.notifyLocalListeners();
      });

      this.watchFile(this.committedFile, (content) => {
        this._committedContents = content;
        this.notifyCommittedListeners();
      });
    } catch (error) {
      console.error("Failed to initialize EditorController:", error);
    }
  }

  private async watchFile(file: File, onUpdate: (content: string) => void) {
    try {
      for await (const event of file.getEvents()) {
        if (this.disposed) break;

        onUpdate(event.content);
      }
    } catch (error) {
      if (!this.disposed) {
        console.error(`Error watching file ${file.path}:`, error);
      }
    }
  }

  get localContents(): string {
    return this._localContents;
  }

  get committedContents(): string {
    return this._committedContents;
  }

  get editor(): EditorState {
    return this._editor;
  }

  setCodeEditor(editor: MonacoEditorType.IStandaloneCodeEditor) {
    this.clearEditor();
    this._editor = { type: "code", editor };

    console.debug(
      "New editor, Setting code editor content to ",
      this._localContents,
    );
    editor.setValue(this._localContents);

    const disposable = editor.onDidChangeModelContent(() => {
      console.debug("onDidChangeModelContent fired");
      const newContent = editor.getValue();
      this.updateLocalContents(newContent);
    });
    this.editorCleanups.push(disposable);
  }

  setDiffEditor(editor: MonacoEditorType.IStandaloneDiffEditor) {
    this.clearEditor();
    this._editor = { type: "diff", editor };

    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.setValue(this._localContents);

    const disposable = modifiedEditor.onDidChangeModelContent(() => {
      const newContent = modifiedEditor.getValue();
      this.updateLocalContents(newContent);
    });
    this.editorCleanups.push(disposable);
  }

  clearEditor() {
    // Clean up any existing editor listeners
    this.editorCleanups.forEach((disposable) => disposable.dispose());
    this.editorCleanups = [];
    this._editor = { type: "none" };
  }

  updateLocalContents(newContent: string) {
    if (this._localContents === newContent) return;

    console.debug("updateLocalContents: updated to:", newContent);
    this._localContents = newContent;
    this.notifyLocalListeners();

    // Cancel previous auto-save and schedule new one
    if (this.autoSaveTimeoutId) {
      clearTimeout(this.autoSaveTimeoutId);
    }

    this.autoSaveTimeoutId = setTimeout(() => {
      this.save();
    }, 10000) as any; // 10 seconds
  }

  private async save() {
    if (!this.workingFile || this.disposed) return;

    try {
      // Use the remote contents as the "old" content for proper merging
      const result = await this.workingFile.writeFile(
        this._remoteContents,
        this._localContents,
      );
      // The file_written event will update _remoteContents automatically
      console.log("File saved successfully");
    } catch (error) {
      console.error("Failed to save file:", error);
    }
  }

  addLocalContentsChangedListener(
    listener: ContentsChangedListener,
  ): () => void {
    this.localListeners.add(listener);

    return () => {
      this.localListeners.delete(listener);
    };
  }

  addCommittedContentsChangedListener(
    listener: ContentsChangedListener,
  ): () => void {
    this.committedListeners.add(listener);

    return () => {
      this.committedListeners.delete(listener);
    };
  }

  private notifyLocalListeners() {
    this.localListeners.forEach((listener) => listener(this._localContents));
  }

  private notifyCommittedListeners() {
    this.committedListeners.forEach((listener) =>
      listener(this._committedContents),
    );
  }

  dispose() {
    this.disposed = true;

    if (this.autoSaveTimeoutId) {
      clearTimeout(this.autoSaveTimeoutId);
      this.autoSaveTimeoutId = null;
    }

    if (this.workingFile) {
      this.workingFile.close();
      this.workingFile = null;
    }

    if (this.committedFile) {
      this.committedFile.close();
      this.committedFile = null;
    }

    this.localListeners.clear();
    this.committedListeners.clear();
  }
}
