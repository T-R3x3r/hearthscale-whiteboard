/**
 * The boards, in a sidebar of Excalidraw's own: one row per board, the
 * open one marked, each with Rename and Delete, and New board at the top.
 * A deletion asks once more first.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sidebar } from '@excalidraw/excalidraw';
import type { BoardEntry } from './boards.ts';

/** The sidebar's name in Excalidraw. */
export const BOARDS = 'boards';

/** The longest name a board takes. */
const NAME_CHARS = 80;

export function BoardList({
  boards,
  open,
  docked,
  onDock,
  onNew,
  onOpen,
  onRename,
  onDelete,
}: {
  boards: readonly BoardEntry[];
  open: string;
  docked: boolean;
  onDock: (docked: boolean) => void;
  onNew: () => void;
  onOpen: (board: BoardEntry) => void;
  onRename: (board: BoardEntry, name: string) => void;
  onDelete: (board: BoardEntry) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<BoardEntry | null>(null);
  return (
    <Sidebar name={BOARDS} docked={docked} onDock={onDock} className="wb-sidebar">
      <Sidebar.Header>
        <span className="wb-boards-title">Boards</span>
      </Sidebar.Header>
      <div className="wb-boards">
        <button
          type="button"
          className="hs-button wb-boards-new"
          data-variant="secondary"
          data-size="sm"
          onClick={onNew}
        >
          <i aria-hidden="true" className="hs-icon ri-add-line wb-icon" />
          New board
        </button>
        <ul className="wb-board-list">
          {boards.map((board) => (
            <li key={board.id} className="wb-board" aria-current={board.id === open || undefined}>
              {renaming === board.id ? (
                <NameField
                  name={board.name}
                  onDone={(name) => {
                    setRenaming(null);
                    if (name !== null && name !== board.name) onRename(board, name);
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="wb-board-name"
                    title={board.name}
                    onClick={() => onOpen(board)}
                    onDoubleClick={() => setRenaming(board.id)}
                  >
                    {board.name}
                  </button>
                  <button
                    type="button"
                    className="hs-icon-button wb-board-act"
                    data-size="sm"
                    title="Rename"
                    aria-label={`Rename ${board.name}`}
                    onClick={() => setRenaming(board.id)}
                  >
                    <i aria-hidden="true" className="hs-icon ri-pencil-line wb-icon" />
                  </button>
                  <button
                    type="button"
                    className="hs-icon-button wb-board-act"
                    data-size="sm"
                    title="Delete"
                    aria-label={`Delete ${board.name}`}
                    onClick={() => setDeleting(board)}
                  >
                    <i aria-hidden="true" className="hs-icon ri-delete-bin-line wb-icon" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
      {deleting && (
        <Confirm
          title={`Delete "${deleting.name}"?`}
          action="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            setDeleting(null);
            onDelete(deleting);
          }}
        />
      )}
    </Sidebar>
  );
}

/** The field a board's name is changed in: Enter or leaving it keeps the
 *  name, Escape keeps the old one. Answers null for no change. */
function NameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    field.current?.select();
  }, []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    onDone(keep && next ? next : null);
  };
  return (
    <input
      ref={field}
      className="hs-input wb-board-field"
      data-variant="text"
      aria-label="Board name"
      value={value}
      maxLength={NAME_CHARS}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
    />
  );
}

/** A dialog over the whole view that asks once more before a deletion;
 *  Escape and a press outside it cancel. Excalidraw counts a press in it
 *  as one inside the sidebar, which stays open. */
function Confirm({
  title,
  action,
  onConfirm,
  onCancel,
}: {
  title: string;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  return createPortal(
    <div
      className="hs-confirm wb-confirm"
      data-prevent-outside-click
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="hs-confirm-box" role="dialog" onClick={(e) => e.stopPropagation()}>
        <span className="hs-confirm-title">{title}</span>
        <div className="hs-confirm-footer">
          <button
            type="button"
            className="hs-button hs-confirm-cancel"
            data-variant="secondary"
            data-size="sm"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="hs-button hs-confirm-action"
            data-variant="danger"
            data-size="sm"
            onClick={onConfirm}
          >
            {action}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
