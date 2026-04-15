export interface HerdConflict {
  id: string;
  herder: string;
}

export interface HerdReassignment {
  id: string;
  fromLeader: string;
}

export interface HerdSessionsResponse {
  herded: string[];
  notFound: string[];
  conflicts: HerdConflict[];
  reassigned: HerdReassignment[];
  leaders: string[];
}

export type HerdChangeEvent =
  | {
      type: "reassigned";
      workerId: string;
      fromLeaderId: string;
      toLeaderId: string;
      reviewerCount: number;
    }
  | {
      type: "membership_changed";
      leaderId: string;
    };
