import React from 'react';

import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/ui';

type TextContentProps = {
  content: string;
  format?: 'plain' | 'json' | 'code';
  className?: string;
};

const LARGE_CONTENT_CHARS = 1_200;
const LARGE_CONTENT_LINES = 16;

/**
 * Renders plain text, JSON, or code content.
 * Used by chat's ToolRenderer as the default content of a tool result.
 */
export const TextContent: React.FC<TextContentProps> = ({
  content,
  format = 'plain',
  className = ''
}) => {
  let displayContent = content;
  if (format === 'json') {
    try {
      displayContent = JSON.stringify(JSON.parse(content), null, 2);
    } catch (error) {
      console.warn('Failed to parse JSON content:', error);
    }
  }

  const isLarge = displayContent.length > LARGE_CONTENT_CHARS
    || displayContent.split('\n').length > LARGE_CONTENT_LINES;
  // Content that grows past the limit while streaming stays open rather than
  // collapsing underneath the user.
  const [expanded, setExpanded] = React.useState(() => !isLarge);
  const isExporting = useIsExportingTranscript();

  let body: React.ReactNode;
  if (format === 'json') {
    body = (
      <pre className={`mt-1 overflow-x-auto rounded bg-gray-900 p-2.5 font-mono text-xs text-gray-100 dark:bg-gray-950 ${className}`}>
        {displayContent}
      </pre>
    );
  } else if (format === 'code') {
    body = (
      <pre className={`mt-1 overflow-hidden whitespace-pre-wrap break-words rounded border border-gray-200/50 bg-gray-50 p-2 font-mono text-xs text-gray-700 dark:border-gray-700/50 dark:bg-gray-800/50 dark:text-gray-300 ${className}`}>
        {content}
      </pre>
    );
  } else {
    body = (
      <div className={`mt-1 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300 ${className}`}>
        {content}
      </div>
    );
  }

  if (!isLarge || isExporting) {
    return <>{body}</>;
  }

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="group/content">
      <CollapsibleTrigger className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <svg
          className="h-3 w-3 transition-transform duration-150 group-data-[state=open]/content:rotate-90"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {expanded ? 'Hide content' : 'Show content'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {expanded && body}
      </CollapsibleContent>
    </Collapsible>
  );
};
