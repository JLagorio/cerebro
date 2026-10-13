import { createContext } from 'react';

/**
 * The vault path of the note an editor is showing (M51.5).
 *
 * An inline chip is handed the editor, and the editor does not know which file
 * it holds — so a chip that reads its own note (a citation numbers itself from
 * the note's frontmatter `sources`) has nowhere to ask. NoteBodyEditor is where
 * a body is bound to its path, and it provides this around the editor.
 * BlockNote renders node views through portals inside BlockNoteView's own
 * React tree, so the provider reaches every chip; a module-level map keyed by
 * editor would be filled only once the editor was ready, after the chips had
 * already rendered, and nothing would tell them to look again.
 *
 * Null outside a NoteBodyEditor: a bare MarkdownEditor has no file.
 *
 * A module of its own rather than a line in chips.tsx: NoteBodyEditor is on
 * the boot path, and chips.tsx imports BlockNote, which LazyMarkdownEditor
 * exists to keep off it.
 */
export const NotePathContext = createContext<string | null>(null);
