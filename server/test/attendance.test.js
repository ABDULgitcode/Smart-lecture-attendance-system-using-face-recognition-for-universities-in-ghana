import test from 'node:test';
import assert from 'node:assert/strict';
import { attendancePercentage, bestMatches, decideMatch, statusForTime } from '../src/utils/attendance.js';

test('marks a student late only after the threshold', () => {
  const start = new Date('2026-10-16T10:00:00Z');
  assert.equal(statusForTime(start, new Date('2026-10-16T10:10:00Z'), 10), 'present');
  assert.equal(statusForTime(start, new Date('2026-10-16T10:10:01Z'), 10), 'late');
});

test('computes attendance against closed lectures', () => {
  assert.equal(attendancePercentage({ present: 7, late: 1, absent: 2, excused: 0 }, 10), 80);
  assert.equal(attendancePercentage({ present: 0, late: 0, absent: 0, excused: 0 }, 0), null);
  assert.equal(attendancePercentage({ present: 0, late: 0, absent: 0, excused: 2 }, 2), 100);
});

test('accepts a clear match and rejects a close one', () => {
  assert.equal(decideMatch([{ score: 0.9 }, { score: 0.8 }], { threshold: 0.75, margin: 0.06 }).type, 'match');
  assert.equal(decideMatch([{ score: 0.8 }, { score: 0.76 }], { threshold: 0.75, margin: 0.06 }).type, 'ambiguous');
  assert.equal(decideMatch([{ score: 0.5 }], { threshold: 0.75, margin: 0.06 }).type, 'unknown');
});

test('matches a face to the enrolled student', () => {
  const roster = [
    { id: 'ama', name: 'Ama Mensah', indexNumber: '10203040', embeddings: [[1, 0]] },
    { id: 'kojo', name: 'Kojo Owusu', indexNumber: '10203041', embeddings: [[0, 1]] },
  ];
  const matched = bestMatches([1, 0], roster, { threshold: 0.75, margin: 0.06 });
  assert.equal(matched.decision.type, 'match');
  assert.equal(matched.decision.best.studentId, 'ama');

  const crowded = bestMatches([1, 0], [
    { id: 'ama', name: 'Ama', indexNumber: '1', embeddings: [[1, 0]] },
    { id: 'kojo', name: 'Kojo', indexNumber: '2', embeddings: [[0.98, 0.2]] },
  ], { threshold: 0.75, margin: 0.06 });
  assert.equal(crowded.decision.type, 'ambiguous');
});
