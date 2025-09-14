import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WS from "jest-websocket-mock";
import FileSystem, { FileSystemError } from "./index.js";
import { FileSystemState } from "./types.js";

describe("FileSystem", () => {
  let server: WS;
  let fs: FileSystem;
  const WS_URL = "ws://localhost:8080";

  beforeEach(async () => {
    server = new WS(WS_URL, { jsonProtocol: true });
    fs = new FileSystem(WS_URL);
  });

  afterEach(() => {
    fs.disconnect();
    WS.clean();
  });

  describe("connection management", () => {
    it("should start in DISCONNECTED state", () => {
      expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);
    });

    it("should transition to CONNECTING then CONNECTED", async () => {
      const states: FileSystemState[] = [];
      const removeListener = fs.addStateListener((state) => {
        states.push(state);
      });

      // Trigger connection by calling writeFile
      const writePromise = fs.writeFile("test.txt", "old", "new");

      // Accept the connection
      await server.connected;

      // Send response
      server.send({
        type: "file_written",
        path: "test.txt",
        content: "new",
      });

      await writePromise;

      expect(states).toContain(FileSystemState.DISCONNECTED);
      expect(states).toContain(FileSystemState.CONNECTING);
      expect(states).toContain(FileSystemState.CONNECTED);

      removeListener();
    });

    it("should handle connection errors", async () => {
      server.error();

      await expect(fs.writeFile("test.txt", "old", "new")).rejects.toThrow(
        FileSystemError,
      );

      expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);
    });

    it("should handle connection close", async () => {
      // Start a write operation
      const writePromise = fs.writeFile("test.txt", "old", "new");

      await server.connected;

      // Close connection before sending response
      server.close();

      await expect(writePromise).rejects.toThrow("Connection closed");
      expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);
    });
  });

  describe("writeFile", () => {
    it("should send write_file command and return new content", async () => {
      const writePromise = fs.writeFile(
        "TASKS.md",
        "old content",
        "new content",
      );

      await server.connected;

      // Verify the command was sent correctly
      await expect(server).toReceiveMessage({
        type: "write_file",
        path: "TASKS.md",
        last_content: "old content",
        new_content: "new content",
      });

      // Send successful response
      server.send({
        type: "file_written",
        path: "TASKS.md",
        content: "merged content",
      });

      const result = await writePromise;
      expect(result).toBe("merged content");
    });

    it("should handle write errors", async () => {
      const writePromise = fs.writeFile("TASKS.md", "old", "new");

      await server.connected;
      await expect(server).toReceiveMessage({
        type: "write_file",
        path: "TASKS.md",
        last_content: "old",
        new_content: "new",
      });

      // Send error response
      server.send({
        type: "error",
        path: "TASKS.md",
        message: "File not found",
      });

      await expect(writePromise).rejects.toThrow("File not found");
    });

    it("should handle unexpected response type", async () => {
      const writePromise = fs.writeFile("test.txt", "old", "new");

      await server.connected;
      await expect(server).toReceiveMessage({
        type: "write_file",
        path: "test.txt",
        last_content: "old",
        new_content: "new",
      });

      // Send unexpected response
      server.send({
        type: "committed",
      });

      await expect(writePromise).rejects.toThrow(
        "Unexpected response type: committed",
      );
    });
  });

  describe("commit", () => {
    it("should send commit command and complete successfully", async () => {
      const commitPromise = fs.commit("Test commit message");

      await server.connected;

      // Verify the command was sent correctly
      await expect(server).toReceiveMessage({
        type: "commit",
        message: "Test commit message",
      });

      // Send successful response
      server.send({
        type: "committed",
      });

      await expect(commitPromise).resolves.toBeUndefined();
    });

    it("should handle commit errors", async () => {
      const commitPromise = fs.commit("Test commit");

      await server.connected;
      await expect(server).toReceiveMessage({
        type: "commit",
        message: "Test commit",
      });

      // Send error response
      server.send({
        type: "error",
        message: "Nothing to commit",
      });

      await expect(commitPromise).rejects.toThrow("Nothing to commit");
    });
  });

  describe("FIFO command handling", () => {
    it("should handle multiple commands in order", async () => {
      // Start multiple commands - they will queue up
      const write1Promise = fs.writeFile("file1.txt", "old1", "new1");

      await server.connected;

      // Wait for first command
      await expect(server).toReceiveMessage({
        type: "write_file",
        path: "file1.txt",
        last_content: "old1",
        new_content: "new1",
      });

      // Start second command after connection is established
      const write2Promise = fs.writeFile("file2.txt", "old2", "new2");
      await expect(server).toReceiveMessage({
        type: "write_file",
        path: "file2.txt",
        last_content: "old2",
        new_content: "new2",
      });

      // Start third command
      const commitPromise = fs.commit("Test commit");
      await expect(server).toReceiveMessage({
        type: "commit",
        message: "Test commit",
      });

      // Send responses in order
      server.send({
        type: "file_written",
        path: "file1.txt",
        content: "result1",
      });

      server.send({
        type: "file_written",
        path: "file2.txt",
        content: "result2",
      });

      server.send({
        type: "committed",
      });

      // Verify results
      expect(await write1Promise).toBe("result1");
      expect(await write2Promise).toBe("result2");
      await expect(commitPromise).resolves.toBeUndefined();
    });

    it("should ignore file_updated events in FIFO", async () => {
      const writePromise = fs.writeFile("test.txt", "old", "new");

      await server.connected;
      await expect(server).toReceiveMessage({
        type: "write_file",
        path: "test.txt",
        last_content: "old",
        new_content: "new",
      });

      // Send file_updated (should be ignored)
      server.send({
        type: "file_updated",
        path: "other.txt",
        content: "updated content",
      });

      // Send actual response
      server.send({
        type: "file_written",
        path: "test.txt",
        content: "new content",
      });

      expect(await writePromise).toBe("new content");
    });
  });

  describe("state listeners", () => {
    it("should call listener immediately with current state", () => {
      const states: FileSystemState[] = [];
      fs.addStateListener((state) => states.push(state));

      expect(states).toEqual([FileSystemState.DISCONNECTED]);
    });

    it("should remove listener when returned function is called", async () => {
      const states1: FileSystemState[] = [];
      const states2: FileSystemState[] = [];

      // Add two listeners
      const removeListener1 = fs.addStateListener((state) =>
        states1.push(state),
      );
      const removeListener2 = fs.addStateListener((state) =>
        states2.push(state),
      );

      // Both should get initial state
      expect(states1).toEqual([FileSystemState.DISCONNECTED]);
      expect(states2).toEqual([FileSystemState.DISCONNECTED]);

      // Remove first listener
      removeListener1();

      // Trigger state change by connecting
      const writePromise = fs.writeFile("test.txt", "old", "new");
      await server.connected;

      await expect(server).toReceiveMessage({
        type: "write_file",
        path: "test.txt",
        last_content: "old",
        new_content: "new",
      });

      server.send({
        type: "file_written",
        path: "test.txt",
        content: "new",
      });
      await writePromise;

      // First listener should not have received new states (still just initial)
      expect(states1).toEqual([FileSystemState.DISCONNECTED]);

      // Second listener should have received all state changes
      expect(states2).toEqual([
        FileSystemState.DISCONNECTED,
        FileSystemState.CONNECTING,
        FileSystemState.CONNECTED,
      ]);

      removeListener2();
    });
  });
});
