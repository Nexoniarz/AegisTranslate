# AegisTranslate on NixOS

On NixOS the local helper is installed declaratively: Firefox finds native-messaging hosts
only through its Nix wrapper, so `helper/install.sh` is not used. The helper package
([`helper/default.nix`](../helper/default.nix)) brings its own `llama-server` and registers
itself with Firefox. You only add it to your configuration.

## 1. Graphics

The helper needs a working GPU driver with Vulkan (or CUDA). Most setups already have this:

```nix
hardware.graphics.enable = true;
# NVIDIA only: the proprietary driver also provides NVIDIA's Vulkan driver.
services.xserver.videoDrivers = [ "nvidia" ];
```

Check that your GPU shows up with `nix shell nixpkgs#vulkan-tools -c vulkaninfo --summary`.

## 2. Add the helper

Pick the variant that matches how you manage your system. All of them use the
`programs.firefox` NixOS module; if you install Firefox another way, see
[Home Manager](#home-manager) below.

### configuration.nix with a local clone

```bash
git clone https://github.com/Nexoniarz/AegisTranslate.git ~/AegisTranslate
```

```nix
{ pkgs, ... }:
{
  programs.firefox = {
    enable = true;
    nativeMessagingHosts.packages = [
      (pkgs.callPackage /home/you/AegisTranslate/helper { })
    ];
  };
}
```

`git pull` in the clone, then rebuild, to update.

### configuration.nix without a clone

```nix
{ pkgs, ... }:
let
  aegistranslate = builtins.fetchTarball {
    url = "https://github.com/Nexoniarz/AegisTranslate/archive/refs/heads/main.tar.gz";
    # Optional but recommended: pin it. Run the rebuild once without sha256;
    # the error message prints the hash to paste here.
    # sha256 = "...";
  };
in
{
  programs.firefox = {
    enable = true;
    nativeMessagingHosts.packages = [ (pkgs.callPackage "${aegistranslate}/helper" { }) ];
  };
}
```

### Flakes

The repository is not a flake; take it as a plain source input:

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    aegistranslate = {
      url = "github:Nexoniarz/AegisTranslate";
      flake = false;
    };
  };

  outputs = { nixpkgs, aegistranslate, ... }: {
    nixosConfigurations.yourhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      specialArgs = { inherit aegistranslate; };
      modules = [ ./configuration.nix ];
    };
  };
}
```

```nix
# configuration.nix
{ pkgs, aegistranslate, ... }:
{
  programs.firefox.nativeMessagingHosts.packages = [
    (pkgs.callPackage "${aegistranslate}/helper" { })
  ];
}
```

Update with `nix flake update aegistranslate`.

### Home Manager

```nix
programs.firefox = {
  enable = true;
  nativeMessagingHosts = [ (pkgs.callPackage /path/to/AegisTranslate/helper { }) ];
};
```

Then rebuild (`sudo nixos-rebuild switch` or `home-manager switch`) and **restart Firefox**.
It reads the list of native-messaging hosts only at startup.

## 3. Optional: the `--check` command

To see which GPU the helper will use, also put it on your `PATH`:

```nix
environment.systemPackages = [ (pkgs.callPackage /home/you/AegisTranslate/helper { }) ];
```

```console
$ aegistranslate-helper --check
llama-server: /nix/store/…-llama-cpp-…/bin/llama-server
  Vulkan0: AMD Radeon Graphics (RADV RENOIR) (25063 MiB)
  Vulkan1: NVIDIA GeForce RTX 3060 Ti (8438 MiB)
will use: NVIDIA GeForce RTX 3060 Ti
```

## 4. Turn it on in Firefox

Open the AegisTranslate popup, choose **Engine → Local helper**, allow the permission Firefox
asks for, and press **Check**. The header shows the GPU the helper picked. The first
translation downloads the model (2.5–6 GB) into `~/.cache/huggingface/hub`.

## Vulkan or CUDA?

| | Vulkan (default) | CUDA |
|---|---|---|
| GPUs | any vendor: NVIDIA, AMD, Intel | NVIDIA only |
| Install | prebuilt in the NixOS binary cache | compiled locally on first rebuild (can take an hour) |
| Needs | nothing extra | `nixpkgs.config.allowUnfree = true` |
| Speed | fast; e.g. ~110 tokens/s for Qwen3 4B on an RTX 3060 Ti | somewhat faster prompt and image processing |

Start with Vulkan. For CUDA:

```nix
(pkgs.callPackage /home/you/AegisTranslate/helper { cudaSupport = true; })
```

To shorten the CUDA build, compile only for your card's architecture, for example
`nixpkgs.config.cudaCapabilities = [ "8.6" ];` for RTX 30-series. This rebuilds every CUDA
package in your system with that setting.

## Hybrid graphics (PRIME offload, iGPU + dedicated GPU)

This is what the helper is for. Keep Firefox on the integrated GPU: **don't** start it with
`nvidia-offload` or set `__NV_PRIME_RENDER_OFFLOAD` for it, which often causes rendering
glitches, broken video decoding and higher power draw. The helper runs `llama-server` on the
dedicated card for compute only. PRIME offload doesn't need to be involved, and the card goes
idle again when the helper stops (after the idle time set in the popup).

The helper prefers a dedicated GPU over an integrated one. Integrated GPUs report shared system
RAM as their memory, so they often look bigger than the real card. To force a device, put its
name from `--check` in `~/.config/aegistranslate/helper.json`:

```json
{ "device": "Vulkan1" }
```

## Troubleshooting

**"The local helper is not installed."** Firefox can't see the host. Restart Firefox after
rebuilding, then check that the manifest is inside the Firefox package you are running:

```bash
ls "$(dirname "$(readlink -f "$(command -v firefox)")")/../lib/mozilla/native-messaging-hosts"
# should list aegistranslate_helper.json
```

If it is missing, the `programs.firefox.nativeMessagingHosts.packages` line isn't part of the
configuration that was built, or you run a Firefox that isn't from `programs.firefox` (for
example the Flatpak, which can't start native helpers without extra setup).

**The wrong GPU is used.** Run `aegistranslate-helper --check` and set `"device"` as above.

**Helper errors.** The helper writes its log (including `llama-server` output) to the Browser
Console: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>, filter for `aegistranslate-helper`.

**The first answer after installing is slow.** The NVIDIA driver compiles Vulkan shaders on
first use and caches them; later starts take a few seconds.
