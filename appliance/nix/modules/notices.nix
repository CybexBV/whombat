# What the image is licensed under, and what it contains by others (Whombat hermes-engine.md HE-63): this repository's
# LICENSE (AGPL-3.0-only) and THIRD_PARTY_NOTICES.md (the image's components, Hermes Agent's MIT notice) in
# /etc/whombat/ on every image. The components' own notices stay with their packages; the file says where.
{
  environment.etc."whombat/LICENSE".source = ../../LICENSE;
  environment.etc."whombat/THIRD_PARTY_NOTICES.md".source = ../../THIRD_PARTY_NOTICES.md;
}
