#!/bin/sh
# uplnk installer
# Usage: curl -fsSL https://uplnk.pixelabs.net/install.sh | sh
#
# Environment overrides:
#   UPLNK_VERSION     — specific version to install (e.g. "0.3.1" or "v0.3.1")
#   UPLNK_INSTALL_DIR — override install directory
#   UPLNK_FORCE=1     — skip "already installed" prompt and always upgrade
#
# Modelled after https://get.helm.sh and the GitHub CLI installer.

set -u

# ---------------------------------------------------------------------------
# Global temp-dir cleanup — defined here so the trap can find it at signal
# time regardless of which function is on the call stack. The empty-string
# guard makes it a no-op if mktemp hasn't run yet.
# ---------------------------------------------------------------------------
_tmpdir=""
_cleanup() { [ -n "${_tmpdir}" ] && rm -rf "${_tmpdir}"; }

GITHUB_REPO="thepixelabs/uplnk"
RELEASES_URL="https://github.com/${GITHUB_REPO}/releases"
GITHUB_API="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
BINARY_NAME="uplnk"

# ---------------------------------------------------------------------------
# Color helpers — only emit ANSI codes when stdout is a TTY
# ---------------------------------------------------------------------------

_tty() { [ -t 1 ]; }

_bold()    { if _tty; then printf '\033[1m%s\033[0m'    "$*"; else printf '%s' "$*"; fi; }
_green()   { if _tty; then printf '\033[0;32m%s\033[0m' "$*"; else printf '%s' "$*"; fi; }
_yellow()  { if _tty; then printf '\033[0;33m%s\033[0m' "$*"; else printf '%s' "$*"; fi; }
_red()     { if _tty; then printf '\033[0;31m%s\033[0m' "$*"; else printf '%s' "$*"; fi; }
_cyan()    { if _tty; then printf '\033[0;36m%s\033[0m' "$*"; else printf '%s' "$*"; fi; }

info()    { printf '  %s %s\n' "$(_cyan "==>")   " "$*"; }
success() { printf '  %s %s\n' "$(_green "OK")    " "$*"; }
warn()    { printf '  %s %s\n' "$(_yellow "WARN") " "$*" >&2; }
error()   { printf '  %s %s\n' "$(_red "ERROR")   " "$*" >&2; }
die()     { error "$*"; exit 1; }

# ---------------------------------------------------------------------------
# OS / architecture detection
# ---------------------------------------------------------------------------

detect_os() {
    _uname_s="$(uname -s 2>/dev/null)"
    case "${_uname_s}" in
        Darwin)           echo "darwin" ;;
        Linux)            echo "linux"  ;;
        MINGW*|MSYS*|CYGWIN*)
            printf '\n'
            info "Windows detected."
            printf '\n'
            printf '  uplnk has a native Windows binary. Download it from:\n'
            printf '  %s\n\n' "$(_bold "${RELEASES_URL}/latest")"
            printf '  Or use the PowerShell installer:\n'
            printf '  %s\n\n' "$(_bold "iwr https://uplnk.pixelabs.net/install.ps1 | iex")"
            exit 0
            ;;
        *)
            die "Unsupported operating system: ${_uname_s}. Only macOS and Linux are supported by this script."
            ;;
    esac
}

detect_arch() {
    _uname_m="$(uname -m 2>/dev/null)"
    case "${_uname_m}" in
        x86_64|amd64)    echo "x64"   ;;
        aarch64|arm64)   echo "arm64" ;;
        *)
            die "Unsupported architecture: ${_uname_m}. Supported: x86_64, aarch64/arm64."
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Version resolution
# ---------------------------------------------------------------------------

get_latest_version() {
    _dl_tool="$1"   # "curl" or "wget"
    info "Resolving latest release from GitHub..."

    if [ "${_dl_tool}" = "curl" ]; then
        _response="$(curl -fsSL "${GITHUB_API}" 2>/dev/null)"
    else
        _response="$(wget -qO- "${GITHUB_API}" 2>/dev/null)"
    fi

    if [ -z "${_response}" ]; then
        die "Could not reach GitHub API (${GITHUB_API}). Check your network connection."
    fi

    # Extract tag_name field — avoid jq dependency with portable sed/grep
    _version="$(printf '%s' "${_response}" | grep '"tag_name"' | head -n1 | sed 's/.*"tag_name":[ ]*"//; s/".*//')"

    if [ -z "${_version}" ]; then
        die "Could not parse version from GitHub API response."
    fi

    # Strip leading 'v' to get a bare semver (e.g. "0.3.1")
    _version="${_version#v}"
    echo "${_version}"
}

# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------

detect_downloader() {
    if command -v curl >/dev/null 2>&1; then
        echo "curl"
    elif command -v wget >/dev/null 2>&1; then
        echo "wget"
    else
        die "Neither curl nor wget found. Install one and retry."
    fi
}

# download_file <url> <destination>
download_file() {
    _url="$1"
    _dest="$2"
    _dl="$3"   # "curl" or "wget"

    if [ "${_dl}" = "curl" ]; then
        if ! curl -fsSL --progress-bar -o "${_dest}" "${_url}"; then
            return 1
        fi
    else
        # wget --show-progress is a GNU wget extension; BusyBox wget ignores it.
        # Write to a .part file and rename on success so a failed attempt never
        # leaves a partial file at the destination path.
        _part="${_dest}.part"
        if wget -q --show-progress -O "${_part}" "${_url}" 2>/dev/null; then
            mv "${_part}" "${_dest}"
        elif wget -q -O "${_part}" "${_url}"; then
            mv "${_part}" "${_dest}"
        else
            rm -f "${_part}"
            return 1
        fi
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Checksum verification
# ---------------------------------------------------------------------------

verify_checksum() {
    _binary="$1"
    _checksum_file="$2"

    if command -v sha256sum >/dev/null 2>&1; then
        # Strip \r in case the sidecar was generated on Windows (CRLF endings)
        _expected="$(awk '{print $1}' "${_checksum_file}" | tr -d '\r')"
        _actual="$(sha256sum "${_binary}" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
        _expected="$(awk '{print $1}' "${_checksum_file}" | tr -d '\r')"
        _actual="$(shasum -a 256 "${_binary}" | awk '{print $1}')"
    else
        warn "No checksum tool found (sha256sum / shasum). Skipping verification."
        return 0
    fi

    if [ "${_expected}" != "${_actual}" ]; then
        error "Checksum mismatch!"
        error "  Expected: ${_expected}"
        error "  Actual:   ${_actual}"
        return 1
    fi

    success "Checksum verified."
    return 0
}

# ---------------------------------------------------------------------------
# Install directory selection
# ---------------------------------------------------------------------------

choose_install_dir() {
    if [ -n "${UPLNK_INSTALL_DIR:-}" ]; then
        echo "${UPLNK_INSTALL_DIR}"
        return
    fi

    # Prefer /usr/local/bin — check if writable or if sudo is available
    if [ -w "/usr/local/bin" ]; then
        echo "/usr/local/bin"
        return
    fi

    if command -v sudo >/dev/null 2>&1; then
        # Caller will prepend sudo when writing
        echo "/usr/local/bin"
        return
    fi

    # Fall back to ~/.local/bin
    echo "${HOME}/.local/bin"
}

needs_sudo() {
    _dir="$1"
    [ ! -w "${_dir}" ] && command -v sudo >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Already-installed check
# ---------------------------------------------------------------------------

check_existing() {
    if ! command -v uplnk >/dev/null 2>&1; then
        return  # not installed, nothing to do
    fi

    _current="$(uplnk --version 2>/dev/null | head -n1 || echo "unknown")"
    printf '\n'
    warn "uplnk is already installed: $(_bold "${_current}")"
    printf '\n'

    if [ "${UPLNK_FORCE:-0}" = "1" ]; then
        info "UPLNK_FORCE=1 — upgrading without prompt."
        return
    fi

    # Interactive prompt only when stdin is a TTY
    if [ -t 0 ]; then
        printf '  Upgrade to the latest version? [y/N] '
        read -r _answer </dev/tty
        case "${_answer}" in
            y|Y|yes|YES) return ;;
            *)
                info "Skipped. Run with UPLNK_FORCE=1 to upgrade non-interactively."
                exit 0
                ;;
        esac
    else
        warn "Non-interactive mode. Set UPLNK_FORCE=1 to upgrade automatically."
        exit 0
    fi
}

# ---------------------------------------------------------------------------
# Binary download
# ---------------------------------------------------------------------------

download_binary() {
    _os="$1"
    _arch="$2"
    _version="$3"
    _dl="$4"
    _tmpdir="$5"

    _binary_name="${BINARY_NAME}-${_os}-${_arch}"
    _url="${RELEASES_URL}/download/v${_version}/${_binary_name}"
    _dest="${_tmpdir}/${BINARY_NAME}"

    info "Downloading ${_binary_name} v${_version}..."
    if ! download_file "${_url}" "${_dest}" "${_dl}"; then
        die "Download failed. URL: ${_url}\n\n  Check that v${_version} exists: ${RELEASES_URL}"
    fi

    # Attempt checksum sidecar — non-fatal if absent
    _sha_url="${_url}.sha256"
    _sha_dest="${_dest}.sha256"

    info "Downloading checksum file..."
    if download_file "${_sha_url}" "${_sha_dest}" "${_dl}" 2>/dev/null; then
        if ! verify_checksum "${_dest}" "${_sha_dest}"; then
            rm -f "${_dest}" "${_sha_dest}"
            die "Binary checksum verification failed. The download may be corrupt or tampered with."
        fi
    else
        warn "No checksum file found at ${_sha_url} — skipping verification."
        warn "Consider reporting this to the uplnk maintainers."
    fi

    echo "${_dest}"
}

# ---------------------------------------------------------------------------
# Install binary to target directory
# ---------------------------------------------------------------------------

install_binary() {
    _src="$1"
    _install_dir="$2"

    # Create directory if it doesn't exist. Try without sudo first — a
    # non-existent user-owned path (e.g. ~/.local/bin) is not writable, so
    # needs_sudo() would return true and trigger an unnecessary sudo prompt.
    if [ ! -d "${_install_dir}" ]; then
        info "Creating install directory: ${_install_dir}"
        mkdir -p "${_install_dir}" 2>/dev/null || \
            sudo mkdir -p "${_install_dir}" || \
            die "Could not create ${_install_dir}"
    fi

    _dest="${_install_dir}/${BINARY_NAME}"

    info "Installing to ${_dest}..."
    if needs_sudo "${_install_dir}"; then
        sudo cp "${_src}" "${_dest}" || die "Could not copy binary to ${_dest}"
        sudo chmod +x "${_dest}"    || die "Could not chmod ${_dest}"
    else
        cp "${_src}" "${_dest}" || die "Could not copy binary to ${_dest}"
        chmod +x "${_dest}"    || die "Could not chmod ${_dest}"
    fi

    success "Installed ${_dest}"
}

# ---------------------------------------------------------------------------
# PATH advisory
# ---------------------------------------------------------------------------

check_path() {
    _install_dir="$1"

    # If the directory is already in PATH, nothing to do
    case ":${PATH}:" in
        *":${_install_dir}:"*) return ;;
    esac

    printf '\n'
    warn "${_install_dir} is not in your PATH."
    printf '\n'
    printf '  Add it by appending the following to your shell profile\n'
    printf '  (~/.bashrc, ~/.zshrc, ~/.profile, or equivalent):\n'
    printf '\n'
    printf '    %s\n' "$(_bold "export PATH=\"${_install_dir}:\$PATH\"")"
    printf '\n'
    printf '  Then reload your shell:\n'
    printf '    %s\n\n' "$(_bold "source ~/.bashrc  # or ~/.zshrc")"
}

# ---------------------------------------------------------------------------
# Post-install verification
# ---------------------------------------------------------------------------

verify_install() {
    _install_dir="$1"

    # Resolve the binary directly in case PATH hasn't been updated yet
    _bin="${_install_dir}/${BINARY_NAME}"

    info "Verifying installation..."
    if ! _ver="$("${_bin}" --version 2>/dev/null)"; then
        warn "uplnk was installed but '${_bin} --version' failed."
        warn "This may be a libc compatibility issue on older systems."
        warn "Please report this at: https://github.com/${GITHUB_REPO}/issues"
        return 1
    fi

    success "uplnk ${_ver} is ready."
    return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    printf '\n'
    printf '  %s\n' "$(_bold "uplnk installer")"
    printf '  %s\n\n' "https://github.com/${GITHUB_REPO}"

    # 1. Detect environment
    _os="$(detect_os)"
    _arch="$(detect_arch)"
    _dl="$(detect_downloader)"

    info "Platform: ${_os}/${_arch}"
    info "Downloader: ${_dl}"

    # 2. Resolve version
    if [ -n "${UPLNK_VERSION:-}" ]; then
        _version="${UPLNK_VERSION#v}"   # strip leading 'v' if present
        info "Using requested version: ${_version}"
    else
        _version="$(get_latest_version "${_dl}")"
        info "Latest version: ${_version}"
    fi

    # 3. Check if already installed
    check_existing

    # 4. Choose install directory
    _install_dir="$(choose_install_dir)"
    info "Install directory: ${_install_dir}"

    # 5. Download to a temp directory.
    # Register the trap BEFORE mktemp so no window exists between allocation
    # and cleanup registration. _cleanup and _tmpdir are defined at the top of
    # the script so the handler is visible to the shell at signal-dispatch time.
    trap _cleanup EXIT INT TERM
    _tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t uplnk-install)"

    # 6. Download + verify
    _binary="$(download_binary "${_os}" "${_arch}" "${_version}" "${_dl}" "${_tmpdir}")"

    # 7. Install
    install_binary "${_binary}" "${_install_dir}"

    # 8. PATH advisory
    check_path "${_install_dir}"

    # 9. Smoke test
    verify_install "${_install_dir}"

    printf '\n'
    printf '  %s\n\n' "$(_bold "Next steps:")"
    printf '    uplnk doctor    # check provider connectivity\n'
    printf '    uplnk           # start chatting\n'
    printf '    uplnk --help    # full command reference\n'
    printf '\n'
}

main "$@"
