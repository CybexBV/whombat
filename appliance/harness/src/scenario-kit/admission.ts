/** Admission ticket claims (MA-06) for assertions; the relay does the verification. */
export interface AdmissionClaims {
  iss: string;
  aud: string;
  rol: 'client' | 'appliance';
  apl: string;
  sub: string;
  org?: string;
  wrk: string;
  chn?: 'app' | 'enroll';
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

export function decodeAdmissionClaims(jws: string): AdmissionClaims {
  const part = jws.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as AdmissionClaims;
}
