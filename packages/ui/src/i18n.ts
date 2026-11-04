import { createElement, Fragment, type ReactNode } from 'react';

/** The UI's language: Korean when the browser or the desktop app runs in Korean, as for Excalidraw's own UI. */
export const korean = navigator.language.toLowerCase().startsWith('ko');
export const langCode = korean ? 'ko-KR' : 'en';

/** Korean by its English original. English is the key, and what shows for anything not listed here. */
const KO: Record<string, string> = {
  // App
  'Open this canvas with {command} so the browser receives its access token.': '{command}로 캔버스를 열어 주세요. 그래야 브라우저가 접근 토큰을 받아요.',
  'Loading…': '불러오는 중…',
  'Loading canvas…': '캔버스 불러오는 중…',
  'Canvas': '캔버스',
  'AI sidebar': 'AI 사이드바',
  'AI sidebar (⌘J)': 'AI 사이드바 (⌘J)',

  // Canvas
  'Widgets cannot be copied. Ask the agent for another one.': '위젯은 복사할 수 없어요. 에이전트에게 하나 더 만들어 달라고 해 주세요.',
  'Widgets belong to agent recipes. Remove them through the agent or `exp apply`.': '위젯은 에이전트의 레시피에 속해요. 에이전트나 `exp apply`로 지워 주세요.',
  '{name} is editing this. You can use it again when it finishes.': '{name}에서 수정하고 있어요. 끝나면 다시 쓸 수 있어요.',
  '{n} source': '소스 {n}개',
  '{n} sources': '소스 {n}개',
  '{n} awaiting approval': '승인 대기 {n}',
  '{n} need repair': '복구 필요 {n}',

  // Widgets
  'Allow source "{source}" to run on schedule?': '"{source}" 소스를 정해진 주기로 실행할까요?',
  '(in {cwd})': '(위치: {cwd})',
  'This recipe runs a command on your machine.': '이 레시피는 내 컴퓨터에서 명령을 실행해요.',
  'Review & approve': '확인하고 승인',
  'Moved by you; agents will not move it': '직접 옮긴 위젯이라 에이전트가 옮기지 않아요',
  'Unknown widget: {type}': '알 수 없는 위젯: {type}',
  'Loading {name}': '{name} 불러오는 중',
  'needs approval': '승인 필요',
  'needs_approval': '승인 필요',
  'fresh': '최신',
  'pending': '대기 중',
  'stale': '오래됨',
  'error': '오류',
  '{status} — click to refresh now': '{status} · 누르면 지금 새로고침해요',
  '{ago} · next {until}': '{ago} · {until} 갱신',
  'just now': '방금',
  '{n}m ago': '{n}분 전',
  '{n}h ago': '{n}시간 전',
  '{n}d ago': '{n}일 전',
  '{n}s': '{n}초 후',
  '{n}m': '{n}분 후',
  '{n}h': '{n}시간 후',

  // AI sidebar
  'New conversation': '새 대화',
  'Conversation': '대화',
  'Untitled': '제목 없음',
  'Settings': '설정',
  'Back': '뒤로',
  'Back (Esc)': '뒤로 (Esc)',
  'Close': '닫기',
  'Close (Esc)': '닫기 (Esc)',
  'Agent': '에이전트',
  'Looking…': '찾는 중…',
  '{name} (not installed)': '{name} (설치 안 됨)',
  'the agent': '에이전트',
  'Ask {name} about this canvas, or to draw on it. Select something first and say “this”.':
    '{name}에게 이 캔버스에 대해 묻거나 그려 달라고 해 보세요. 먼저 선택하고 “이거”라고 말해도 돼요.',
  'Working': '작업 중',
  '{name} asks to use {tool}': '{name}에서 {tool} 사용을 요청했어요',
  'Allow': '허용',
  'Deny': '거부',
  'Allowed': '허용함',
  'Denied': '거부함',
  'No longer needed': '더 이상 필요 없음',
  '{n} selected': '{n}개 선택됨',
  'Do not send the selection': '선택한 것 보내지 않기',
  'Send {label} along': '{label} 함께 보내기',
  '{name} is waiting for your answer above.': '{name}에서 위의 답을 기다리고 있어요.',
  'Install Claude Code or Codex to start': '시작하려면 Claude Code나 Codex를 설치해 주세요',
  'Looking for agents…': '에이전트를 찾는 중…',
  'Neither Claude Code nor Codex is installed on this computer.': '이 컴퓨터에는 Claude Code도 Codex도 설치되어 있지 않아요.',
  'Message {name}': '{name}에게 메시지 보내기',
  'Stop': '중지',
  'Send': '보내기',
  'Send (Enter)': '보내기 (Enter)',

  // Its settings
  'This sidebar needs no setup. Connected agents can also draw on your canvases from their own sessions, such as in your terminal.':
    '이 사이드바는 설정 없이 바로 쓸 수 있어요. 연결된 에이전트는 터미널 같은 자기 세션에서도 캔버스에 그릴 수 있어요.',
  'Open agent activity': '에이전트 활동 보기',
  'Agents pick up changes in their next session.': '바뀐 설정은 에이전트의 다음 세션부터 적용돼요.',
  'not found on this computer': '이 컴퓨터에 없음',
  'Canvas tools': '캔버스 도구',
  'Connected': '연결됨',
  'Connected, with an older setup': '연결됨 (이전 설정)',
  'Not connected': '연결 안 됨',
  'Connect': '연결',
  'Disconnect': '연결 끊기',
  'Update': '업데이트',
  'Activity': '활동 기록',
  'Reported to the canvas': '캔버스에 표시 중',
  'Partly on': '일부 켜짐',
  'Off': '꺼짐',
  'Turn on': '켜기',
  'Turn off': '끄기',
};

/** What the daemon words itself, matched by its English. Anything else, like a command's own error, stays as it came. */
const KO_MESSAGES: [RegExp, string][] = [
  [/^Stopped\.$/, '중지했어요.'],
  [/^(\d+) selected$/, '$1개 선택됨'],
  [/^dry run, (\d+) changes? on (.+)$/, '$2 미리 보기, 변경 $1개'],
  [/^dry run, (\d+) changes?$/, '미리 보기, 변경 $1개'],
  [/^(\d+) changes? on (.+)$/, '$2에 변경 $1개'],
  [/^(\d+) changes?$/, '변경 $1개'],
  [/^(.+) is still working on the last message$/, '$1에서 아직 이전 메시지를 처리하고 있어요'],
  [/^(.+) is not installed on this computer\.$/, '이 컴퓨터에 설치되어 있지 않아요: $1'],
  [/^the agent is no longer running$/, '에이전트가 더 이상 실행 중이 아니에요'],
  [/^The (\S+) command was not found\. Install (.+), or run the commands below where it is\.$/, '$1 명령을 찾지 못했어요. $2를 설치하거나, 설치된 곳에서 아래 명령을 실행해 주세요.'],
  [/^Codex runs new hooks only after you trust them: .+$/, 'Codex는 새 훅을 신뢰해야 실행해요. Codex의 /hooks나 ChatGPT 앱의 설정 > Hooks에서 exprything 훅을 신뢰해 주세요.'],
  [/^An older exprything server added to .+ only \(local scope\) overrides this one there: (.+)$/, '프로젝트에만 추가된 예전 exprything 서버가 이 설정을 가리고 있어요: $1'],
];

const template = (text: string) => (korean && KO[text]) || text;

/** `text` in the UI's language, with each {name} in it filled in from `vars`. */
export function t(text: string, vars: Record<string, string | number> = {}): string {
  return template(text).replace(/\{(\w+)\}/g, (all, key: string) => String(vars[key] ?? all));
}

/** t() for text with elements in it. */
export function tRich(text: string, parts: Record<string, ReactNode>): ReactNode {
  return createElement(Fragment, null, ...template(text).split(/\{(\w+)\}/).map((s, i) => (i % 2 ? parts[s] : s)));
}

/** A message from the daemon in the UI's language. */
export function tMessage(text: string): string {
  if (!korean) return text;
  const known = KO_MESSAGES.find(([pattern]) => pattern.test(text));
  return known ? text.replace(known[0], known[1]) : text;
}
