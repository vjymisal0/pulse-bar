UUID = pulse-bar@vjymisal0.github.io
ZIP  = dist/$(UUID).shell-extension.zip

.PHONY: pack install test clean

pack:
	mkdir -p dist
	gnome-extensions pack --force --extra-source=lib --out-dir=dist .

install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Installed. Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

test:
	gjs -m tests/parse.test.js

clean:
	rm -rf dist
