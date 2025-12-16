export interface ProposalSummary {
  proposal_id: string;
  proposer: string;
  description: string;
  start_block: number;
  end_block: number;
  state: number;
}
