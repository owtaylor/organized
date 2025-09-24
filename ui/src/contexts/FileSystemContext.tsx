import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import FileSystem, { FileSystemState } from "../filesystem";

interface FileSystemContextType {
  fileSystem: FileSystem;
  state: FileSystemState;
}

const FileSystemContext = createContext<FileSystemContextType | null>(null);

interface FileSystemProviderProps {
  children: ReactNode;
}

export function FileSystemProvider({ children }: FileSystemProviderProps) {
  const [fileSystem] = useState(() => {
    const protocolPrefix =
      window.location.protocol === "https:" ? "wss:" : "ws:";
    const websocketUrl = protocolPrefix + "//" + window.location.host + "/ws";
    return new FileSystem(websocketUrl);
  });

  const [state, setState] = useState<FileSystemState>(fileSystem.getState());

  useEffect(() => {
    const removeListener = fileSystem.addStateListener(setState);
    return removeListener;
  }, [fileSystem]);

  return (
    <FileSystemContext.Provider value={{ fileSystem, state }}>
      {children}
    </FileSystemContext.Provider>
  );
}

export function useFileSystem(): FileSystemContextType {
  const context = useContext(FileSystemContext);
  if (!context) {
    throw new Error("useFileSystem must be used within a FileSystemProvider");
  }
  return context;
}
