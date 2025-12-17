import type { VoteView } from '../types/votes';

const API_PREFIX =
  typeof window !== 'undefined' && window.location.pathname.includes('hypr-dao:hypr-dao:ware.hypr')
    ? '/hypr-dao:hypr-dao:ware.hypr'
    : '';

function parseResponse<T>(json: any): T {
  if (json && Object.prototype.hasOwnProperty.call(json, 'Ok')) {
    return json.Ok as T;
  }
  if (json && Object.prototype.hasOwnProperty.call(json, 'Err')) {
    throw new Error(String(json.Err));
  }
  throw new Error('Unexpected response shape from API');
}

export async function fetchVotes(proposalId: string): Promise<VoteView[]> {
  const response = await fetch(`${API_PREFIX}/api/get-votes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ GetVotes: proposalId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to load votes (status ${response.status})`);
  }
  const json = await response.json();
  return parseResponse<VoteView[]>(json);
}
