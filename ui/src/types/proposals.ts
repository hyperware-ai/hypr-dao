export interface ProposalSummary {
  proposal_id: string;
  proposer: string;
  description: string;
  start_block: number;
  end_block: number;
  state: number;
  queued_at: number;
  execute_after: number;
  min_delay_seconds: number;
  executed_at: number;
}
