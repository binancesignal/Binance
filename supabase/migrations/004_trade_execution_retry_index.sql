-- Exchange rejections are terminal attempts and should not permanently block
-- a later retry after the user corrects the Bybit testnet account/configuration.
DROP INDEX IF EXISTS uq_trade_exec_signal_side;

CREATE UNIQUE INDEX uq_trade_exec_signal_side
  ON trade_executions (signal_id, side)
  WHERE status NOT IN ('FAILED', 'CANCELLED', 'REJECTED');