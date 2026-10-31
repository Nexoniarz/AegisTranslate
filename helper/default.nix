# AegisTranslate local helper for NixOS.
#
# In configuration.nix:
#   programs.firefox.nativeMessagingHosts.packages = [
#     (pkgs.callPackage /path/to/AegisTranslate/helper { })
#   ];
#
# cudaSupport needs nixpkgs.config.allowUnfree = true and builds llama.cpp
# with CUDA (not in the public binary cache, so the first build takes a while).
# vulkanSupport = true works for any GPU vendor and needs no unfree packages.
{
  lib,
  runCommand,
  writeShellScript,
  python3,
  llama-cpp,
  cudaSupport ? false,
  vulkanSupport ? !cudaSupport,
}:

let
  llama = llama-cpp.override { inherit cudaSupport vulkanSupport; };
  launcher = writeShellScript "aegistranslate-helper" ''
    export AEGIS_LLAMA_SERVER=${lib.getExe' llama "llama-server"}
    exec ${python3.interpreter} ${./aegistranslate_helper.py} "$@"
  '';
  manifest = builtins.toJSON {
    name = "aegistranslate_helper";
    description = "AegisTranslate local helper (llama.cpp)";
    path = "${launcher}";
    type = "stdio";
    allowed_extensions = [ "aegistranslate@nexoniarz" ];
  };
in
runCommand "aegistranslate-helper" { passAsFile = [ "manifest" ]; inherit manifest; } ''
  mkdir -p $out/bin $out/lib/mozilla/native-messaging-hosts
  ln -s ${launcher} $out/bin/aegistranslate-helper
  cp $manifestPath $out/lib/mozilla/native-messaging-hosts/aegistranslate_helper.json
''
