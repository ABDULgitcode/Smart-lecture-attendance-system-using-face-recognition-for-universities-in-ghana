export function cosine(left, right) {
  if (!left?.length || !right?.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function statusForTime(startedAt, markedAt, lateAfterMinutes) {
  const minutes = (new Date(markedAt).getTime() - new Date(startedAt).getTime()) / 60000;
  return minutes > lateAfterMinutes ? 'late' : 'present';
}

export function attendancePercentage(counts, closedSessions) {
  if (!closedSessions) return null;
  const excused = counts.excused || 0;
  const attended = (counts.present || 0) + (counts.late || 0);
  const denominator = closedSessions - excused;
  if (denominator <= 0) return 100;
  return Math.round((attended / denominator) * 1000) / 10;
}

export function decideMatch(scores, { threshold, margin }) {
  if (!scores.length || scores[0].score < threshold) {
    return { type: 'unknown', best: scores[0] || null };
  }
  if (scores[1] && scores[0].score - scores[1].score < margin) {
    return { type: 'ambiguous', best: scores[0], second: scores[1] };
  }
  return { type: 'match', best: scores[0] };
}

export function bestMatches(embedding, roster, settings) {
  const scores = roster
    .filter((student) => student.embeddings?.length)
    .map((student) => {
      let best = 0;
      for (const vector of student.embeddings) {
        const score = cosine(embedding, vector);
        if (score > best) best = score;
      }
      return {
        studentId: student.id,
        name: student.name,
        indexNumber: student.indexNumber,
        score: best,
      };
    })
    .sort((a, b) => b.score - a.score);
  return { decision: decideMatch(scores, settings), scores: scores.slice(0, 3) };
}

export function roundScore(value) {
  return Math.round(value * 1000) / 1000;
}
