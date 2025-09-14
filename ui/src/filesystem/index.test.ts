import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WS from "jest-websocket-mock";
import FileSystem, { FileSystemError } from "./index.js";
import { FileEvent, FileSystemState } from "./types.js";

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

  describe("openFile AsyncGenerator", () => {
    it("should send open_file command and yield file_opened event", async () => {
      const fileIterator = fs.openFile("TASKS.md");

      const [{ value: event, done }] = await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });

          // Send file_opened response
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Initial content",
          });
        })(),
      ]);

      expect(done).toBe(false);
      expect(event).toEqual({
        type: "file_opened",
        path: "TASKS.md",
        content: "Initial content",
      });

      // Clean up
      await fileIterator.return(undefined);
    });

    it("should yield file_updated events for external changes", async () => {
      const fileIterator = fs.openFile("TASKS.md");

      const [initialEvent] = await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Initial content",
          });
        })(),
      ]);

      // Now send a file_updated event
      server.send({
        type: "file_updated",
        path: "TASKS.md",
        content: "Updated content",
      });

      // Get the updated event
      const { value: updateEvent, done } = await fileIterator.next();

      expect(done).toBe(false);
      expect(updateEvent).toEqual({
        type: "file_updated",
        path: "TASKS.md",
        content: "Updated content",
      });

      // Clean up
      await fileIterator.return(undefined);
    });

    it("should yield file_written events for this client's writes", async () => {
      const fileIterator = fs.openFile("TASKS.md");

      const [initialEvent] = await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Initial content",
          });
        })(),
      ]);

      // Start a write operation and get the file_written event
      const writePromise = fs.writeFile(
        "TASKS.md",
        "Initial content",
        "New content",
      );

      const [{ value: writeEvent, done }] = await Promise.all([
        fileIterator.next(),
        (async () => {
          await expect(server).toReceiveMessage({
            type: "write_file",
            path: "TASKS.md",
            last_content: "Initial content",
            new_content: "New content",
          });
          server.send({
            type: "file_written",
            path: "TASKS.md",
            content: "New content",
          });
        })(),
      ]);

      expect(done).toBe(false);
      expect(writeEvent).toEqual({
        type: "file_written",
        path: "TASKS.md",
        content: "New content",
      });

      // The writeFile promise should also resolve
      expect(await writePromise).toBe("New content");

      // Clean up
      await fileIterator.return(undefined);
    });

    it("should handle multiple file events in sequence", async () => {
      const fileIterator = fs.openFile("TASKS.md");
      const events: any[] = [];

      const [event1] = await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "v1",
          });
        })(),
      ]);

      events.push(event1.value);

      // Send file_updated and collect event
      server.send({
        type: "file_updated",
        path: "TASKS.md",
        content: "v2",
      });

      events.push((await fileIterator.next()).value);

      // Send another file_updated and collect event
      server.send({
        type: "file_updated",
        path: "TASKS.md",
        content: "v3",
      });

      events.push((await fileIterator.next()).value);

      expect(events).toEqual([
        { type: "file_opened", path: "TASKS.md", content: "v1" },
        { type: "file_updated", path: "TASKS.md", content: "v2" },
        { type: "file_updated", path: "TASKS.md", content: "v3" },
      ]);

      // Clean up
      await fileIterator.return(undefined);
    });

    it("blah blah blah", async () => {
      async function* asyncGeneratorExample() {
        yield 1;
        yield 2;
        yield 3;
        throw new Error("Test error");
      }

      const iterator = asyncGeneratorExample();

      console.log(await iterator.next()); // { value: 1, done: false }
      console.log(await iterator.next()); // { value: 2, done: false }
      console.log(await iterator.next()); // { value: 3, done: false }

      await expect(iterator.next()).rejects.toThrow("Test error");
    });

    it("should handle file opening errors", async () => {
      const fileIterator = fs.openFile("nonexistent.md");

      await Promise.all([
        expect(fileIterator.next()).rejects.toThrow("File not found"),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "nonexistent.md",
          });
          server.send({
            type: "error",
            path: "nonexistent.md",
            message: "File not found",
          });
        })(),
      ]);

      await fileIterator.return(undefined);
    });

    it("should handle disconnection during file watching", async () => {
      const fileIterator = fs.openFile("TASKS.md");

      const [initialEvent] = await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Initial content",
          });
        })(),
      ]);

      // Disconnect
      server.close();

      // Next iteration should throw due to disconnection
      await expect(fileIterator.next()).rejects.toThrow();
    });

    it("should close file when generator is closed", async () => {
      const fileIterator = fs.openFile("TASKS.md");

      const [initialEvent] = await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Initial content",
          });
        })(),
      ]);

      // Close the generator and wait for close command
      await Promise.all([
        fileIterator.return(undefined),
        (async () => {
          await expect(server).toReceiveMessage({
            type: "close_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_closed",
            path: "TASKS.md",
          });
        })(),
      ]);
    });
  });

  describe("file reference counting", () => {
    it("should handle multiple opens of the same file", async () => {
      let fileIterator1: AsyncGenerator<FileEvent>;
      let fileIterator2: AsyncGenerator<FileEvent>;

      await Promise.all([
        // Client 1: open file, get first event, check it, commit
        (async () => {
          fileIterator1 = fs.openFile("TASKS.md");
          const event1 = await fileIterator1.next();
          expect(event1.value).toEqual({
            type: "file_opened",
            path: "TASKS.md",
            content: "Shared content",
          });
          await fs.commit("Test commit 1");

          // Send a file_updated event - should receive it
          const update1 = await fileIterator1.next();
          expect(update1.value).toEqual({
            type: "file_updated",
            path: "TASKS.md",
            content: "Updated content",
          });

          // Close first iterator - should NOT send close_file command yet
          await fileIterator1.return(undefined);
        })(),

        // Client 2: same thing
        (async () => {
          fileIterator2 = fs.openFile("TASKS.md");
          const event2 = await fileIterator2.next();
          expect(event2.value).toEqual({
            type: "file_opened",
            path: "TASKS.md",
            content: "Shared content",
          });
          await fs.commit("Test commit 2");

          // Should receive the same file_updated event
          const update2 = await fileIterator2.next();
          expect(update2.value).toEqual({
            type: "file_updated",
            path: "TASKS.md",
            content: "Updated content",
          });

          // Close second iterator - NOW should send close_file command
          await fileIterator2.return(undefined);
        })(),

        // Server: expect open and send response, then handle commits
        (async () => {
          await server.connected;

          // Should only get one open_file command
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });

          // Send open response first
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Shared content",
          });

          // Expect commits (order doesn't matter)
          const commit1 = await server.nextMessage;
          const commit2 = await server.nextMessage;

          expect([commit1, commit2]).toEqual(
            expect.arrayContaining([
              { type: "commit", message: "Test commit 1" },
              { type: "commit", message: "Test commit 2" },
            ]),
          );

          // Send commit responses
          server.send({ type: "committed" });
          server.send({ type: "committed" });

          // Send file_updated event
          server.send({
            type: "file_updated",
            path: "TASKS.md",
            content: "Updated content",
          });

          // Expect close_file command when second iterator closes
          await expect(server).toReceiveMessage({
            type: "close_file",
            path: "TASKS.md",
          });

          server.send({
            type: "file_closed",
            path: "TASKS.md",
          });
        })(),
      ]);

      // Verify no close_file command was sent after first iterator closed
      const commitPromise = fs.commit("Verification commit");
      await expect(server).toReceiveMessage({
        type: "commit",
        message: "Verification commit",
      });

      server.send({ type: "committed" });
      await commitPromise;
    });

    it("should open file again after all references are closed", async () => {
      await Promise.all([
        (async () => {
          // First open and close cycle
          const fileIterator1 = fs.openFile("TASKS.md");

          await fileIterator1.next();
          await fileIterator1.return(undefined);

          // Second open cycle - should send open_file again
          const fileIterator2 = fs.openFile("TASKS.md");

          const event = await fileIterator2.next();
          expect(event.value.content).toBe("Content v2");

          await fileIterator2.return(undefined);
        })(),
        (async () => {
          await server.connected;

          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Content v1",
          });

          await expect(server).toReceiveMessage({
            type: "close_file",
            path: "TASKS.md",
          });

          server.send({
            type: "file_closed",
            path: "TASKS.md",
          });

          // Second open cycle

          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Content v2",
          });
        })(),
      ]);
    });

    it("should handle reference counting for different files independently", async () => {
      await Promise.all([
        (async () => {
          // Open two different files
          const tasksIterator = fs.openFile("TASKS.md");
          const notesIterator = fs.openFile("notes/daily.md");

          // Get initial events
          await tasksIterator.next();
          await notesIterator.next();

          // Close tasks file
          await tasksIterator.return(undefined);

          // Still get updates for notes file
          const updateEvent = await notesIterator.next();
          expect(updateEvent.value.content).toBe("Updated notes");

          // Close notes file
          await notesIterator.return(undefined);
        })(),
        (async () => {
          await server.connected;

          // Should send open commands for both files

          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Tasks content",
          });

          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "notes/daily.md",
          });

          server.send({
            type: "file_opened",
            path: "notes/daily.md",
            content: "Notes content",
          });

          await expect(server).toReceiveMessage({
            type: "close_file",
            path: "TASKS.md",
          });

          server.send({
            type: "file_closed",
            path: "TASKS.md",
          });

          // Notes file should still be open - send an update to verify
          server.send({
            type: "file_updated",
            path: "notes/daily.md",
            content: "Updated notes",
          });

          await expect(server).toReceiveMessage({
            type: "close_file",
            path: "notes/daily.md",
          });

          server.send({
            type: "file_closed",
            path: "notes/daily.md",
          });
        })(),
      ]);
    });
  });

  describe("real-time notification system", () => {
    it("should handle multiple files receiving updates simultaneously", async () => {
      // Open both files
      const tasksIterator = fs.openFile("TASKS.md");
      const notesIterator = fs.openFile("notes.md");

      await Promise.all([
        (async () => {
          // Get initial events
          await tasksIterator.next();
          await notesIterator.next();
        })(),
        (async () => {
          await server.connected;

          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Tasks",
          });

          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "notes.md",
          });

          server.send({
            type: "file_opened",
            path: "notes.md",
            content: "Notes",
          });
        })(),
      ]);

      // Send updates to both files.  We hd to wait until the
      // initial events are processed before sending updates,
      // otherwise the file_updated events might be compressed into
      // the initial file_opened event.

      server.send({
        type: "file_updated",
        path: "TASKS.md",
        content: "Updated tasks",
      });

      server.send({
        type: "file_updated",
        path: "notes.md",
        content: "Updated notes",
      });

      // Both should receive their respective updates
      const tasksUpdate = await tasksIterator.next();
      const notesUpdate = await notesIterator.next();

      expect(tasksUpdate.value.content).toBe("Updated tasks");
      expect(notesUpdate.value.content).toBe("Updated notes");

      await tasksIterator.return(undefined);
      await notesIterator.return(undefined);
    });
  });

  describe("Phase 6c: Connection states and reconnection", () => {
    it("should handle multiple simultaneous connect() calls", async () => {
      await Promise.all([
        // Client operations
        (async () => {
          const writePromise1 = fs.writeFile("file1.txt", "old1", "new1");
          const writePromise2 = fs.writeFile("file2.txt", "old2", "new2");
          const commitPromise = fs.commit("Test commit");

          // All promises should resolve
          expect(await writePromise1).toBe("new1");
          expect(await writePromise2).toBe("new2");
          await expect(commitPromise).resolves.toBeUndefined();

          expect(fs.getState()).toBe(FileSystemState.CONNECTED);
        })(),

        // Server responses
        (async () => {
          await server.connected;

          // Handle commands in order
          await expect(server).toReceiveMessage({
            type: "write_file",
            path: "file1.txt",
            last_content: "old1",
            new_content: "new1",
          });

          server.send({
            type: "file_written",
            path: "file1.txt",
            content: "new1",
          });

          await expect(server).toReceiveMessage({
            type: "write_file",
            path: "file2.txt",
            last_content: "old2",
            new_content: "new2",
          });

          server.send({
            type: "file_written",
            path: "file2.txt",
            content: "new2",
          });

          await expect(server).toReceiveMessage({
            type: "commit",
            message: "Test commit",
          });

          server.send({
            type: "committed",
          });
        })(),
      ]);
    });

    it("should transition to RECONNECT_WAIT on connection loss with open files", async () => {
      // Open a file first
      const fileIterator = fs.openFile("TASKS.md");

      await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "Initial content",
          });
        })(),
      ]);

      expect(fs.getState()).toBe(FileSystemState.CONNECTED);

      // Close connection
      server.close();

      // Should transition to RECONNECT_WAIT (not DISCONNECTED) because file is open
      await new Promise(resolve => setTimeout(resolve, 10)); // Give state change time
      expect(fs.getState()).toBe(FileSystemState.RECONNECT_WAIT);

      // Clean up
      await fileIterator.return(undefined);
    });

    it("should transition to DISCONNECTED on connection loss without open files", async () => {
      // Make a simple operation without keeping files open
      const writePromise = fs.writeFile("test.txt", "old", "new");

      await server.connected;
      await expect(server).toReceiveMessage({
        type: "write_file",
        path: "test.txt",
        last_content: "old",
        new_content: "new",
      });

      expect(fs.getState()).toBe(FileSystemState.CONNECTED);

      // Close connection before sending response
      server.close();

      await expect(writePromise).rejects.toThrow("Connection closed");

      // Should transition to DISCONNECTED (not RECONNECT_WAIT) because no files are open
      expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);
    });

    it("should reestablish open files on reconnection", async () => {
      const fileIterator = fs.openFile("TASKS.md");

      // Initial connection and file opening
      await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "v1",
          });
        })(),
      ]);

      // Simulate connection loss
      server.close();
      server = new WS(WS_URL, { jsonProtocol: true });

      // Manual reconnection
      const connectPromise = fs.connectNow();

      await Promise.all([
        connectPromise,
        (async () => {
          await server.connected;

          // Should receive reestablishment command for open file
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "v2", // Content changed
          });
        })(),
      ]);

      // Should receive file_updated event (not file_opened) since content changed
      const { value: updateEvent } = await fileIterator.next();
      expect(updateEvent).toEqual({
        type: "file_updated",
        path: "TASKS.md",
        content: "v2",
      });

      await fileIterator.return(undefined);
    });

    it("should not send file_updated on reconnection if content unchanged", async () => {
      const fileIterator = fs.openFile("TASKS.md");

      // Initial connection and file opening
      await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "unchanged",
          });
        })(),
      ]);

      // Simulate connection loss
      server.close();
      server = new WS(WS_URL, { jsonProtocol: true });

      // Manual reconnection
      const connectPromise = fs.connectNow();

      await Promise.all([
        connectPromise,
        (async () => {
          await server.connected;

          // Should receive reestablishment command for open file
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "unchanged", // Same content
          });
        })(),
      ]);

      // Should NOT receive any new events
      // Send another event to verify the generator is still working
      server.send({
        type: "file_updated",
        path: "TASKS.md",
        content: "actually changed",
      });

      const { value: updateEvent } = await fileIterator.next();
      expect(updateEvent).toEqual({
        type: "file_updated",
        path: "TASKS.md",
        content: "actually changed",
      });

      await fileIterator.return(undefined);
    });

    it("should provide public connectNow() method", async () => {
      expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);

      const connectPromise = fs.connectNow();

      await server.connected;
      await connectPromise;

      expect(fs.getState()).toBe(FileSystemState.CONNECTED);
    });

    it("should handle file reestablishment failures gracefully", async () => {
      const fileIterator = fs.openFile("TASKS.md");

      // Initial connection and file opening
      await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "content",
          });
        })(),
      ]);

      // Simulate connection loss
      server.close();
      server = new WS(WS_URL, { jsonProtocol: true });

      // Manual reconnection with file error
      const connectPromise = fs.connectNow();

      await Promise.all([
        connectPromise,
        (async () => {
          await server.connected;

          // Should receive reestablishment command
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });

          // Send error response (file might have been deleted)
          server.send({
            type: "error",
            path: "TASKS.md",
            message: "File not found",
          });
        })(),
      ]);

      // Connection should still be successful despite file error
      expect(fs.getState()).toBe(FileSystemState.CONNECTED);

      await fileIterator.return(undefined);
    });

    it("should clear reconnection timeout on manual disconnect", async () => {
      const fileIterator = fs.openFile("TASKS.md");

      // Initial connection and file opening
      await Promise.all([
        fileIterator.next(),
        (async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            path: "TASKS.md",
            content: "content",
          });
        })(),
      ]);

      // Close connection to trigger reconnection state
      server.close();

      // Give time for RECONNECT_WAIT state
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fs.getState()).toBe(FileSystemState.RECONNECT_WAIT);

      // Manual disconnect should clear timeouts and go to DISCONNECTED
      fs.disconnect();
      expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);

      await fileIterator.return(undefined);
    });
  });
});
