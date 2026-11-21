# The certificate of the gates' update servers (./nodes.nix): one self-signed certificate for the three names the box
# asks, which every gated image trusts (./release.nix). Made with the runner's packages, so the control node and the
# images of every release, whatever their own packages, hold the same one.
{ pkgs }:
rec {
  # Where the box reads the role metadata (the releases repository's Pages site), where it asks for a release's files
  # (GitHub's release downloads: the image's module accepts no other address for the GitHub layout) and where those
  # answers send it (GitHub's storage).
  pages = "releases.example.com";
  github = "github.com";
  storage = "objects.example.com";
  names = [
    pages
    github
    storage
  ];
  cert =
    pkgs.runCommand "whombat-gate-tls" { nativeBuildInputs = [ pkgs.openssl ]; } ''
      openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes -out cert.pem -keyout key.pem \
        -subj '/CN=${pages}' -addext "subjectAltName=${pkgs.lib.concatMapStringsSep "," (n: "DNS:${n}") names}"
      mkdir -p $out
      cp key.pem cert.pem $out
    '';
}
