import { useEffect, useRef, useState } from 'react'
import Editor from './Editor'
import Chat from './Chat'
import { Toaster, toast } from 'react-hot-toast'
import { type MDXEditorMethods } from '@mdxeditor/editor'

function App() {
  const editorRef = useRef<MDXEditorMethods | null>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        const response = await fetch('/api/files/TASKS.md')
        const data = await response.text()
        console.log("tasks.md", data);
        editorRef.current?.setMarkdown(data);
      } catch (error) {
        console.error('Error fetching tasks:', error)
        toast.error('Failed to fetch tasks.')
      }
    }

    fetchTasks()
  }, [editorRef])

  const handleEditorChange = (newMarkdown: string) => {
    console.log("handleEditorChange", newMarkdown)
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = setTimeout(async () => {
      try {
        await fetch('/api/files/TASKS.md', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
          },
          body: newMarkdown,
        })
        toast.success('Tasks saved!')
      } catch (error) {
        console.error('Error saving tasks:', error)
        toast.error('Failed to save tasks.')
      }
    }, 10000)
  }

  return (
    <>
      <Toaster />
      <div className="flex h-screen">
        <div className="w-3/4 p-4">
          <Editor
            editorRef={editorRef}
            markdown=""
            onChange={handleEditorChange}
          />
        </div>
        <div className="w-1/4 border-l">
          <Chat />
        </div>
      </div>
    </>
  )
}

export default App