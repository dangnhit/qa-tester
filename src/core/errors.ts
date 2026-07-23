export class QaSkillsError extends Error {
  public constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "QaSkillsError";
  }
}

export class AuthoringParseError extends QaSkillsError {
  public constructor(message: string) {
    super(message, "AUTHORING_PARSE_ERROR");
    this.name = "AuthoringParseError";
  }
}
