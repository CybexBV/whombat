package com.whombat.updater

import androidx.core.content.FileProvider

/** Its own provider class, so it merges next to the other modules' FileProviders (one per class name). */
class WhombatUpdateFileProvider : FileProvider()
