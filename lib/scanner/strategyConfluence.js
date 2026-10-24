function directionOf(setup) {
  return String(setup?.dir || setup?.direction || '').toUpperCase();
}

function symbolOf(setup) {
  return String(setup?.symbol || '').trim().toUpperCase();
}

function isConfirmedChartPattern(setup) {
  return (
    setup?.strategy === 'chart_pattern' &&
    ['LONG', 'SHORT'].includes(directionOf(setup)) &&
    (setup?.metadata?.breakoutConfirmed === true ||
      setup?.quality?.breakoutConfirmed === true)
  );
}

function scoreOf(setup) {
  return setup?.score != null && Number.isFinite(+setup.score) ? +setup.score : 0;
}

/**
 * Keep ICT entries only when the same symbol's confirmed chart-pattern
 * breakout agrees on direction. The ICT setup remains the source of trade
 * levels; the pattern is confirmation only.
 */
export function requireIctPatternConfluence(results) {
  const setups = Array.isArray(results) ? results : [];
  const patterns = setups.filter(isConfirmedChartPattern);

  return setups
    .filter((setup) => setup?.strategy === 'ict_smc')
    .flatMap((ictSetup) => {
      const direction = directionOf(ictSetup);
      const symbol = symbolOf(ictSetup);
      if (!symbol || !['LONG', 'SHORT'].includes(direction)) return [];

      const match = patterns
        .filter(
          (pattern) =>
            symbolOf(pattern) === symbol &&
            directionOf(pattern) === direction
        )
        .sort((a, b) => scoreOf(b) - scoreOf(a))[0];
      if (!match) return [];

      const patternName =
        match.pattern || match.metadata?.pattern || match.metadata?.patternType || 'Chart Pattern';
      const patternTf = match.metadata?.patternTf || null;
      const patternScore = match.score != null && Number.isFinite(+match.score)
        ? Math.round(+match.score)
        : null;
      const confirmation = {
        pattern: patternName,
        timeframe: patternTf,
        direction,
        score: patternScore,
        breakoutLevel: match.metadata?.breakoutLevel ?? null,
      };
      const timeframeLabel = patternTf ? ` on ${patternTf}` : '';
      const scoreLabel = patternScore == null ? '' : ` (score ${patternScore})`;
      const note = `Chart-pattern ${patternName} breakout confirms ${direction}${timeframeLabel}${scoreLabel}`;
      const conf = Array.isArray(ictSetup.conf) ? ictSetup.conf : [];

      return [{
        ...ictSetup,
        conf: [...conf, note],
        quality: {
          ...(ictSetup.quality || {}),
          chartPatternConfirmed: true,
        },
        metadata: {
          ...(ictSetup.metadata || {}),
          confluenceMode: 'ict_chart_pattern',
          chartPatternConfirmation: confirmation,
        },
      }];
    });
}