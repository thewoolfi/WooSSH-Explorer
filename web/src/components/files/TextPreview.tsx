import { useMemo } from 'react';
import type { FileReadResult } from '../../api/types';
import { languageOf } from '../../lib/path';
import { Icon } from '../ui/Icon';
import { Spinner } from '../ui/Primitives';

const MAX_LINES = 400;
const MAX_CHARS = 40_000;

type Token = { text: string; cls: string };

/** Very small tokenizer — enough to make config and source previews readable. */
function tokenize(line: string, language: string): Token[] {
  const trimmed = line.trimStart();
  if (language !== 'plain' && (trimmed.startsWith('#') || trimmed.startsWith('//'))) {
    return [{ text: line, cls: 'tk-comment' }];
  }
  if (language === 'markup') {
    const tokens: Token[] = [];
    const re = /(<\/?[A-Za-z][\w:-]*)|("[^"]*")|([A-Za-z-]+(?==))|(\/?>)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line))) {
      if (match.index > last) tokens.push({ text: line.slice(last, match.index), cls: '' });
      const cls = match[2] ? 'tk-string' : match[3] ? 'tk-key' : 'tk-punct';
      tokens.push({ text: match[0], cls });
      last = match.index + match[0].length;
    }
    if (last < line.length) tokens.push({ text: line.slice(last), cls: '' });
    return tokens;
  }
  const tokens: Token[] = [];
  const re =
    /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b(?:true|false|null|undefined|function|const|let|var|export|import|from|return|if|else|for|while|class|new|await|async|def|end|then|fi|do|done)\b)|([{}[\]().,;:=<>+\-*/|&!]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    if (match.index > last) tokens.push({ text: line.slice(last, match.index), cls: '' });
    const cls = match[1] || match[2] ? 'tk-string' : match[3] ? 'tk-number' : match[4] ? 'tk-key' : 'tk-punct';
    tokens.push({ text: match[0], cls });
    last = match.index + match[0].length;
  }
  if (last < line.length) tokens.push({ text: line.slice(last), cls: '' });
  return tokens;
}

export function TextPreview({
  result,
  name,
  onDownload,
}: {
  result: FileReadResult;
  name: string;
  onDownload?: () => void;
}) {
  const language = languageOf(name);

  const lines = useMemo(() => {
    const content = result.content ?? '';
    const slice = content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) : content;
    return slice.split('\n').slice(0, MAX_LINES);
  }, [result.content]);

  return (
    <div className="preview">
      <div className="preview__bar">
        <span className="label">Preview</span>
        <span className="spacer" />
        {result.truncated ? <span className="preview__flag">truncated</span> : null}
        <span className="preview__meta mono">
          {result.lines} lines · {result.mimeType}
        </span>
      </div>

      <div className="preview__code scroll-y">
        <table className="code">
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="code__gutter mono">{index + 1}</td>
                <td className="code__line mono">
                  {tokenize(line, language).map((token, tokenIndex) =>
                    token.cls ? (
                      <span key={tokenIndex} className={token.cls}>
                        {token.text}
                      </span>
                    ) : (
                      <span key={tokenIndex}>{token.text}</span>
                    ),
                  )}
                  {line === '' ? '\u200b' : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.truncated && onDownload ? (
        <button type="button" className="preview__more" onClick={onDownload}>
          <Icon name="download" size={13} />
          <span>File is larger than the preview limit — download it</span>
        </button>
      ) : null}
    </div>
  );
}

export function PreviewPlaceholder({ loading, message }: { loading: boolean; message?: string }) {
  return (
    <div className="preview preview--empty">
      {loading ? (
        <>
          <Spinner size={16} />
          <p>Loading preview…</p>
        </>
      ) : (
        <>
          <Icon name="eye" size={18} />
          <p>{message ?? 'Select a file to preview it.'}</p>
        </>
      )}
    </div>
  );
}
