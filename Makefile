# Vortex Language Support — build/install targets.
#
#   make            # package the extension into a .vsix
#   make install    # package and install into the local VS Code (or Server)
#   make reinstall  # uninstall first, then install (forces a clean refresh)
#   make uninstall  # remove the installed extension
#   make clean      # delete generated .vsix files

NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
PUB     := $(shell node -p "require('./package.json').publisher")
VSIX    := $(NAME)-$(VERSION).vsix
EXT_ID  := $(PUB).$(NAME)

CODE ?= code

.PHONY: all package install reinstall uninstall clean

all: package

package: $(VSIX)

$(VSIX): package.json extension.js language-configuration.json \
         syntaxes/vortex.tmLanguage.json \
         syntaxes/vortex-src.tmLanguage.json \
         snippets/vortex.json builtins.json
	npx --yes @vscode/vsce package

builtins.json: scripts/build-builtins.js
	node scripts/build-builtins.js

.PHONY: builtins
builtins:
	node scripts/build-builtins.js

install: package
	$(CODE) --install-extension $(VSIX) --force

reinstall: package
	-$(CODE) --uninstall-extension $(EXT_ID)
	$(CODE) --install-extension $(VSIX) --force

uninstall:
	$(CODE) --uninstall-extension $(EXT_ID)

clean:
	rm -f *.vsix
