declare module "shell-quote" {
  export type ParseToken = string | { op: string } | { comment: string };

  export function parse(input: string): ParseToken[];
}
