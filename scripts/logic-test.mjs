#!/usr/bin/env node
import assert from 'node:assert/strict';
import { ComputerUseSession } from '../lib/session.js';
import { buildMotionPoints } from '../lib/tools.js';

const session = new ComputerUseSession();
session.store({
  window: { bounds: { x: 100, y: 200, width: 800, height: 600 } },
  elements: [
    { index: 7, path: '0.2', frame: { x: 20, y: 40, width: 100, height: 60 } },
  ],
});

assert.deepEqual(session.toScreenPoint(12, 34), { x: 112, y: 234 });
assert.deepEqual(session.toScreenshotPoint(112, 234), { x: 12, y: 34 });
assert.deepEqual(session.elementScreenPoint(7), { x: 170, y: 270 });
assert.deepEqual(session.windowScreenPoint(), { x: 500, y: 500 });

assert.deepEqual(
  buildMotionPoints(null, [{ x: 300, y: 400 }]),
  [{ x: 0, y: 0 }, { x: 300, y: 400 }],
  'a fresh cursor starts from the session origin',
);

session.recordAction('click', 300, 400);
const previous = { ...session.lastScreenPoint };
assert.deepEqual(
  buildMotionPoints(previous, [{ x: 500, y: 600 }]),
  [{ x: 300, y: 400 }, { x: 500, y: 600 }],
  'the next motion starts at the previous action, not a fabricated offset',
);
assert.deepEqual(session.lastScreenPoint, previous, 'planning does not mutate session state');

assert.deepEqual(
  buildMotionPoints(previous, [{ x: 300, y: 400 }, { x: 700, y: 650 }]),
  [{ x: 300, y: 400 }, { x: 300, y: 400 }, { x: 700, y: 650 }],
  'drag press index remains stable when the cursor is already at the start point',
);

console.log('motion/session logic tests passed');
