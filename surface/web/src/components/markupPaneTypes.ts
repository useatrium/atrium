export interface MarkupEditorProps {
  initialMarkdown: string;
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
}

export interface MarkupEditorHandle {
  serialize(): string;
  hasMarkup(): boolean;
}
