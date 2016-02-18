// Copyright 2015 by Paulo Augusto Peccin. See license.txt distributed with this file.

// V9938/V9918 VDPs supported
// This implementation is line-accurate
// Digitize, Superimpose, LightPen, Mouse, Color Bus, External Synch, B/W Mode not supported
// Original base clock: 2147727 Hz which is 6x CPU clock

wmsx.V9938 = function(machine, cpu, psg, isV9918) {
    var self = this;

    function init() {
        // Fixed metrics for V9918
        if (isV9918) {
            signalWidth = wmsx.V9938.SIGNAL_WIDTH_V9918;
            signalHeight = wmsx.V9938.SIGNAL_HEIGHT_V9918;
        }
        videoSignal = new wmsx.VDPVideoSignal();
        cpuClockPulses = cpu.clockPulses;
        psgClockPulse = psg.getAudioOutput().audioClockPulse;
        initFrameResources();
        initColorCaches();
        initDebugPatternTables();
        initSpritesConflictMap();
        mode = 0; modeData = modes[mode];
        self.setDefaults();
        commandProcessor = new wmsx.V9938CommandProcessor();
        commandProcessor.connectVDP(self, vram, register, status);
        commandProcessor.setVDPModeData(modeData);
    }

    this.connectBus = function(bus) {
        bus.connectInputDevice(0x98,  this.input98);
        bus.connectOutputDevice(0x98, this.output98);
        bus.connectInputDevice(0x99,  this.input99);
        bus.connectOutputDevice(0x99, isV9918 ? this.output99_V9918 : this.output99_V9938);
        bus.connectOutputDevice(0x9a, this.output9a);
        bus.connectOutputDevice(0x9b, this.output9b);
    };

    this.powerOn = function() {
        this.reset();
    };

    this.powerOff = function() {
        videoSignal.signalOff();
    };

    this.setVideoStandard = function(pVideoStandard) {
        videoStandard = pVideoStandard;
        updateSynchronization();
        updateSignalMetrics();
        if (currentScanline < startingScanline) currentScanline = startingScanline;          // When going from PAL to NTSC
    };

    this.setVSynchMode = function(mode) {
        vSynchMode = mode;
        updateSynchronization();
    };

    this.getVideoOutput = function() {
        return videoSignal;
    };

    this.getDesiredBaseFrequency = function () {
        return desiredBaseFrequency;
    };

    this.clockPulse = function() {
        // Generate correct amount of lines per cycle, according to the current pulldown cadence
        frameEvents();

        // Finish audio signal (generate any missing samples to adjust to sample rate)
        psg.getAudioOutput().finishFrame();

        // Send updated image to Monitor if needed
        if (refreshPending) refresh();
    };

    // VRAM Read
    this.input98 = function() {
        dataToWrite = null;
        var res = vram[vramPointer++];
        checkVRAMPointerWrap();
        return res;
    };

    // VRAM Write
    this.output98 = function(val) {

        //if (vramPointer === 0x1e205 || vramPointer === 0x1e605) wmsx.Util.log("VRAM Write: " + val.toString(16) + " at: " + vramPointer.toString(16));

        dataToWrite = null;
        vram[vramPointer++] = val;
        checkVRAMPointerWrap();
    };

    // Status Register Read
    this.input99 = function() {
        dataToWrite = null;
        var reg = register[15];

        var res;
        switch(reg) {
            case 0:
                res = getStatus0();                     // Dynamic value. status[0] is never accurate
                break;
            case 1:
                res = status[1];
                status[1] &= ~0x80;                     // FL = 0
                if ((register[0] & 0x10) && (status[1] & 0x01)) {
                    status[1] &= ~0x01;                 // FH = 0, only if interrupts are enabled (IE1 = 1)
                    updateIRQ();
                }
                break;
            case 2:
                commandProcessor.updateStatus();
                res = status[2];

                //if ((res & 0x81) !== 0) logInfo("Reading Command Status NOT READY: " + res.toString(16));

                break;
            case 3: case 4: case 6:
                res = status[reg];
                break;
            case 5:
                res = status[5];
                spritesCollisionX = spritesCollisionY = -1;             // Clear collision coordinates and status registers
                status[3] = status[4] = status[5] = status[6] = 0;
                break;
            case 7:
                commandProcessor.cpuRead();
                res = status[7];
                break;
            case 8: case 9:
                res = status[reg];
                break;
            default:
                res = 0xff;                       // Invalid register
        }

        //logInfo("Reading status " + reg + ", " + res.toString(16));

        return res;
    };

    // Register/VRAM Address write for V9938
    this.output99_V9938 = function(val) {
        if (dataToWrite === null) {
            // First write. Data to write to register or VRAM Address Pointer low (A7-A0)
            dataToWrite = val;
        } else {
            // Second write
            if (val & 0x80) {
                // Register write only if "WriteMode = 0"
                if ((val & 0x40) === 0) registerWrite(val & 0x3f, dataToWrite);
            } else {
                // VRAM Address Pointer middle (A13-A8) and mode (r/w)
                vramPointer = (vramPointer & 0x1c000) | ((val & 0x3f) << 8) | dataToWrite;

                //console.log("Setting VRAM Pointer via out: " + val.toString(16) + ". Pointer: " + vramPointer.toString(16) + ". reg14: " + register[14].toString(16));

            }
            dataToWrite = null;
        }
    };

    // Register/VRAM Address write for V9918
    this.output99_V9918 = function(val) {
        if (dataToWrite === null) {
            // First write. Data to write to register or VRAM Address Pointer low (A7-A0)
            dataToWrite = val;
            // On V9918, the VRAM pointer low gets written right away
            vramPointer = (vramPointer & ~0xff) | val;
        } else {
            // Second write
            if (val & 0x80) {
                registerWrite(val & 0x07, dataToWrite);
                // On V9918, the VRAM pointer high gets also written when writing to registers
                vramPointer = (vramPointer & 0x1c0ff) | ((val & 0x3f) << 8);
            } else {
                // VRAM Address Pointer middle (A13-A8) and mode (r/w)
                vramPointer = (vramPointer & 0x1c000) | ((val & 0x3f) << 8) | dataToWrite;
            }
            dataToWrite = null;
        }
    };

    // Palette Write
    this.output9a = function(val) {
        if (isV9918) return;
        if (paletteFirstWrite === null) {
            paletteFirstWrite = val;
        } else {
            writePaletteRegister(register[16], (val << 8) | paletteFirstWrite);
            if (++register[16] > 15) register[16] = 0;
            paletteFirstWrite = null;
        }
    };

    // Indirect Register Write
    this.output9b = function(val) {
        if (isV9918) return;
        var reg = register[17] & 0x3f;
        if (reg !== 17) registerWrite(reg, val);
        if ((register[17] & 0x80) === 0) register[17] = (reg + 1) & 0x3f;       // Increment if needed
    };

    this.togglePalettes = function() {
        videoSignal.showOSD("Color Mode not supported for MSX2 yet!", true);
    };

    this.toggleDebugModes = function() {
        setDebugMode((debugMode + 1) % 8);
        videoSignal.showOSD("Debug Mode" + (debugMode > 0 ? " " + debugMode : "") + ": "
            + [ "OFF", "Sprites Highlighted", "Sprite Numbers", "Sprite Names",
                "Sprites Hidden", "Pattern Bits", "Pattern Color Blocks", "Pattern Names"][debugMode], true);
    };

    this.toggleSpriteDebugModes = function() {
        spriteDebugMode = ++spriteDebugMode % 4;
        spriteDebugModeLimit = (spriteDebugMode === 0) || (spriteDebugMode === 2);
        spriteDebugModeCollisions = spriteDebugMode < 2;
        videoSignal.showOSD("Sprites Mode" + (spriteDebugMode > 0 ? " " + spriteDebugMode : "") + ": "
            + ["Normal", "Unlimited", "NO Collisions", "Unlimited, No Collisions"][spriteDebugMode], true);
    };

    this.setDefaults = function() {
        spriteDebugMode = 0;
        setDebugMode(0);
    };

    this.reset = function() {
        frame = cycles = lastCPUCyclesComputed = 0;
        dataToWrite = null; vramPointer = 0; paletteFirstWrite = null;
        verticalAdjust = horizontalAdjust = 0;
        backdropColor = 0;
        pendingBlankingChange = false;
        spritesCollided = false; spritesCollisionX = spritesCollisionY = spritesInvalid = -1; spritesMaxComputed = 0;
        verticalIntReached = false; horizontalIntLine = 0;
        initRegisters();
        initColorPalette();
        updateIRQ();
        updateMode();
        updateBackdropColor(true);
        updateSynchronization();
        updateBlinking();
        updatePageAlternance();
        beginFrame();
    };

    this.updateCycles = function() {
        var cpuCycles = cpu.getCycles();
        if (cpuCycles === lastCPUCyclesComputed) return cycles;

        var elapsed = (cpuCycles - lastCPUCyclesComputed) * 6;
        lastCPUCyclesComputed = cpuCycles;
        cycles += elapsed;

        return cycles;
    };

    function registerWrite(reg, val) {
        if (reg > 46) return;

        var add;
        var mod = register[reg] ^ val;
        register[reg] = val;

        //logInfo("Reg: " + reg + " = " + val.toString(16));

        switch (reg) {
            case 0:

                //if (mod) logInfo("Register0: " + val.toString(16));

                if (mod & 0x10) updateIRQ();                             // IE1
                if (mod & 0x0e) updateMode();                            // Mx
                break;
            case 1:

                //if (mod) logInfo("Register1: " + val.toString(16));

                if (mod & 0x20) updateIRQ();                             // IE0
                if (mod & 0x40) {                                        // BL
                    pendingBlankingChange = true;      // only at next line

                    //logInfo("Blanking: " + !!(val & 0x40));
                }
                if (mod & 0x18) updateMode();                            // Mx
                else if (mod & 0x03) updateSpritesLineType();            // SI, MAG. Already ok if mode was updated
                break;
            case 2:
                if ((mod & 0x7f) === 0) break;
                add = (mode === 0x07 ? (val << 11) | 0x400 : val << 10) & 0x1ffff;     // Mode G7 has different A16 position
                layoutTableAddress = add & modeData.layTBase;
                layoutTableAddressMask = add | layoutTableAddressMaskBase;

                //logInfo(/* "Setting: " + val.toString(16) + " to " + */ "NameTableAddress: " + layoutTableAddress.toString(16));

                break;
            case 10:
                if ((mod & 0x07) === 0) break;
                // else fall through
            case 3:
                add = ((register[10] << 14) | (register[3] << 6)) & 0x1ffff;
                colorTableAddress = add & modeData.colorTBase;
                colorTableAddressMask = add | colorTableAddressMaskBase;

                //logInfo("Setting: " + val.toString(16) + " to ColorTableAddress: " + colorTableAddress.toString(16));

                break;
            case 4:
                if ((mod & 0x3f) === 0) break;
                add = (val << 11) & 0x1ffff;
                patternTableAddress = add & modeData.patTBase;
                patternTableAddressMask = add | patternTableAddressMaskBase;

                //logInfo("Setting: " + val.toString(16) + " to PatternTableAddress: " + patternTableAddress.toString(16));

                break;
            case 11:
                if ((mod & 0x03) === 0) break;
                // else fall through
            case 5:
                add = ((register[11] << 15) | (register[5] << 7)) & 0x1ffff;
                spriteAttrTableAddress = add & modeData.sprAttrTBase;

                //logInfo("SpriteAttrTable: " + spriteAttrTableAddress.toString(16));

                break;
            case 6:
                if ((mod & 0x3f) === 0) break;
                add = (val << 11) & 0x1ffff;
                spritePatternTableAddress = add & modeData.sprPatTBase;
                updateSpritePatternTables();

                //logInfo("SpritePatTable: " + spritePatternTableAddress.toString(16));

                break;
            case 7:
                if (mod & (mode === 7 ? 0xff : 0x0f)) updateBackdropColor(false);   // BD. Special case for mode G7
                break;
            case 8:
                if (mod & 0x20) updateTransparency();                    // TP
                if (mod & 0x02) updateSpritesLineType();                 // SPD
                break;
            case 9:
                if (mod & 0x80) updateSignalMetrics();                   // LN
                else if (mod & 0x08) updateSignalMetrics();              // IL. Already OK if LN was changed
                if (mod & 0x04) updatePageAlternance();                  // EO
                if (mod & 0x02) updateVideoStandardSoft();               // NT
                break;
            case 13:
                updateBlinking();                                        // Always, even with no change
                break;
            case 14:
                if (mod & 0x07) vramPointer = ((val & 0x07) << 14) | (vramPointer & 0x3fff);

                //console.log("Setting reg14: " + val.toString(16) + ". VRAM Pointer: " + vramPointer.toString(16));

                break;
            case 16:
                paletteFirstWrite = null;
                break;
            case 18:
                if (mod & 0x0f) horizontalAdjust = -7 + ((val & 0x0f) ^ 0x07);
                if (mod & 0xf0) {
                    verticalAdjust = -7 + ((val >>> 4) ^ 0x07);
                    updateSignalMetrics();
                }
                break;
            case 19:
                horizontalIntLine = (val - register[23]) & 255;

                //logInfo("Line Interrupt set: " + val);

                break;
            case 23:
                horizontalIntLine = (register[19] - val) & 255;

                //logInfo("Vertical offset set: " + val);

                break;
            case 44:
                commandProcessor.cpuWrite(val);
                break;
            case 46:
                commandProcessor.startCommand(val);
                break;
        }
    }

    function getStatus0() {
        var res = 0;

        // Vertical Int
        if (verticalIntReached) {                   // F
            res |= 0x80;
            verticalIntReached = false;
            updateIRQ();
        }

        // Collision
        if (spritesCollided) {
            res |= 0x20;                            // C
            spritesCollided = false;
        }

        // Invalid Sprite, otherwise Greatest Sprite number drawn
        if (spritesInvalid >= 0) {                                          // TODO Report only if F == 0?
            res |= 0x40 | spritesInvalid;           // 5S, 5SN
            spritesInvalid = -1;
        } else
            res |= spritesMaxComputed;              // 5SN

        spritesMaxComputed = 0;

        //console.log("Status0 read: " + res.toString(16));

        return res;                                 // Everything is cleared at this point (like status[0] == 0)
    }

    function checkVRAMPointerWrap() {
        if ((vramPointer & 0x3fff) === 0) {
            //wmsx.Util.log("VRAM Read Wrapped, vramPointer: " + vramPointer.toString(16) + ", register14: " + register[14].toString(16));
            if (modeData.isV9938) register[14] = (register[14] + 1) & 0x07;
            vramPointer = register[14] << 14;
        }
    }

    function writePaletteRegister(reg, val) {
        if (paletteRegister[reg] === val) return;
        paletteRegister[reg] = val;

        var value = colors512[((val & 0x700) >> 2) | ((val & 0x70) >> 1) | (val & 0x07)];     // 11 bit GRB to 9 bit GRB

        // Special case for color 0
        if (reg === 0) {
            if (color0Solid) colorPalette[0] = value;
        } else
            colorPalette[reg] = value;

        colorPalette[reg + 16] = value;

        if (reg === backdropColor) updateBackdropValue(false);
        else if ((mode === 4) && (reg <= 3)) updateBackdropCachesG5();
    }

    function setDebugMode(mode) {
        debugMode = mode;
        debugModeSpriteInfo = mode >= 2 && mode <= 3;
        debugModeSpriteInfoNames = mode === 3;
        debugModePatternInfo = mode >= 5;
        debugModePatternInfoBlocks = mode === 6;
        debugModePatternInfoNames = mode === 7;
        updateLineActiveType();
        updateSpritesLineType();
        updateSpritePatternTables();
        updateBackdropValue(true);
    }

    function updateSynchronization() {
        // Use the native frequency (60Hz or 50Hz) if detected and VSynch matches or is forced, otherwise use the Video Standard target FPS
        var hostFreq = wmsx.Clock.HOST_NATIVE_FPS;
        desiredBaseFrequency = videoStandard.targetFPS;
        if ((vSynchMode === 2) && (hostFreq > 0)) desiredBaseFrequency = hostFreq;

        scanlinesPerCycle = videoStandard.pulldowns[desiredBaseFrequency].linesPerCycle;                          // Always generate this amount of lines per cycle
        pulldownFirstFrameLinesAdjust = videoStandard.pulldowns[desiredBaseFrequency].firstFrameLinesAdjust;      // Unless its the first pulldown frame and is adjusted
    }

    // Total frame lines: 262 for NTSC, 313 for PAL
    // Total frame CPU clocks: 59736 for NTSC, 71364 for PAL
    function frameEvents() {
        var totalLines = scanlinesPerCycle;

        // Adjust for pulldown cadence if this frame is the first pulldown frame
        if (pulldownFirstFrameLinesAdjust && currentScanline == startingScanline) totalLines += pulldownFirstFrameLinesAdjust;

        for (var i = totalLines; i > 0; i = i - 1) {
            // Verify and change sections of the screen
            if (currentScanline === startingActiveScanline) enterActiveDisplay();
            else if (currentScanline === startingBottomBorderScanline) enterBottomBorder();

            lineEvents();

            currentScanline = currentScanline + 1;

            if (currentScanline === finishingScanline) finishFrame();
        }
    }

    // Total line clocks: VDP: 1368, CPU: 228 CPU, PSG 7.125 PSG
    // Timing should be different for mode T1 and T2 since borders are wider. Ignoring for now.
    // This implementation starts each scanline at the Beginning of the Right Border, and ends with the Ending of the Visible Display
    function lineEvents() {
        // Start of line
        //debugLineStartCPUCycles = cpu.getCycles();

        if (pendingBlankingChange) updateLineActiveType();

        // Sync signal: 100 clocks
        // Left erase: 102 clocks

        cpuClockPulses(33); psgClockPulse();

        // Left border: 56 clocks

        if (currentScanline === startingActiveScanline - 1) status[2] &= ~0x40;                     // VR = 0 at the scanline before first Active scanline
        if ((status[1] & 0x01) && ((register[0] & 0x10) === 0))  status[1] &= ~0x01;                // FH = 0 if interrupts disabled (IE1 = 0)
        if (currentScanline === startingBottomBorderScanline) triggerVerticalInterrupt();           // VR = 1, F = 1 at the first Bottom Border line

        cpuClockPulses(10);

        // Visible Display: 1024 clocks

        status[2] &= ~0x20;                                                                         // HR = 0

        cpuClockPulses(22); psgClockPulse();
        cpuClockPulses(33); psgClockPulse();
        cpuClockPulses(32); psgClockPulse();

        if (currentScanline >= startingTopBorderScanline) renderLine();                             // ~ Middle of Display area

        cpuClockPulses(33); psgClockPulse();
        cpuClockPulses(32); psgClockPulse();
        cpuClockPulses(18);

        status[2] |= 0x20;                                                                          // HR = 1
        if (currentScanline - startingActiveScanline === horizontalIntLine) triggerHorizontalInterrupt();   // FH = 1

        // Right border: 59 clocks
        // Right erase: 27 clocks

        cpuClockPulses(15);  psgClockPulse();

        // End of line

        // 1 additional PSG clock each 8 lines should be added to be perfectly in sync
    }

    function triggerVerticalInterrupt() {
        status[2] |= 0x40;                  // VR = 1
        if (!verticalIntReached) {
            verticalIntReached = true;      // Like F = 1
            updateIRQ();
        }

        //logInfo("Vertical Frame Int reached. Ints " + ((register[1] & 0x20) ?  "ENABLED" : "disabled"));
    }

    function triggerHorizontalInterrupt() {
        if ((status[1] & 0x01) === 0) {
            status[1] |= 0x01;              // FH = 1
            updateIRQ();
        }

        //logInfo("Horizontal Int Line reached. Ints " + ((register[0] & 0x10) ?  "ENABLED" : "disabled"));
    }

    function updateIRQ() {
        if ((verticalIntReached && (register[1] & 0x20))            // Like F == 1 and IE0 == 1
            || ((status[1] & 0x01) && (register[0] & 0x10))) {      // FH == 1 and IE1 == 1
            cpu.setINT(0);
        } else {
            cpu.setINT(1);
        }

        //if (verticalIntReached && (register[1] & 0x20)) logInfo(">>>>  INT VERTICAL");
        //if ((status[1] & 0x01) && (register[0] & 0x10)) logInfo(">>>>  INT HORIZONTAL");
    }

    function updateMode() {
        var add;
        var oldMode = mode;
        mode = (register[1] & 0x18) | ((register[0] & 0x0e) >>> 1);
        modeData = modes[mode];

        // Update Tables base addresses
        add = (mode === 0x07 ? (register[2] << 11) | 0x400 : register[2] << 10) & 0x1ffff;       // Mode G7 has different A16 position
        layoutTableAddress = add & modeData.layTBase;
        layoutTableAddressMask = add | layoutTableAddressMaskBase;
        add = ((register[10] << 14) | (register[3] << 6)) & 0x1ffff ;
        colorTableAddress = add & modeData.colorTBase;
        colorTableAddressMask = add | colorTableAddressMaskBase;
        add = (register[4] << 11) & 0x1ffff;
        patternTableAddress = add & modeData.patTBase;
        patternTableAddressMask = add | patternTableAddressMaskBase;
        add = ((register[11] << 15) | (register[5] << 7)) & 0x1ffff ;
        spriteAttrTableAddress = add & modeData.sprAttrTBase;
        add = (register[6] << 11) & 0x1ffff;
        spritePatternTableAddress = add & modeData.sprPatTBase;

        if ((mode === 7) || (oldMode === 7)) updateBackdropColor(true);
        else if ((mode === 4) || (oldMode === 4)) updateBackdropCaches();

        updateLineActiveType();
        updateSpritesLineType();
        updateSignalMetrics();
        updateSpritePatternTables();
        commandProcessor.setVDPModeData(modeData);
        pendingModeChange = false;

        //logInfo("Update Mode: " + mode.toString(16) + ", colorTableAddress: " + colorTableAddress.toString(16));
    }

    function updateVideoStandardSoft() {
        var pal = (register[9] & 0x02);
        machine.setVideoStandardSoft(pal ? wmsx.VideoStandard.PAL : wmsx.VideoStandard.NTSC);

        //logInfo("VDP VideoStandard: " + (pal ? "PAL" : "NTSC"));
    }

    function updateSignalMetrics() {
        var height, vertBorderHeight;

        // Fixed metrics for V9918
        if (isV9918) {
            height = 192; vertBorderHeight = 8;
        } else {
            signalWidth = modeData.width === 512 ? 512 + 16 * 2 : 256 + 8 * 2;          // Mode
            signalHeight = (register[9] & 0x08) ? 424 + 16 * 2 : 212 + 8 * 2;           // IL
            if (register[9] & 0x80) { height = 212; vertBorderHeight = 8; }             // LN
            else { height = 192; vertBorderHeight = 18; }
        }

        startingTopBorderScanline = 0;
        startingActiveScanline = startingTopBorderScanline + vertBorderHeight + verticalAdjust;
        startingBottomBorderScanline = startingActiveScanline + height;
        finishingScanline = startingBottomBorderScanline + vertBorderHeight - verticalAdjust;
        startingScanline = finishingScanline - videoStandard.totalHeight;
    }

    function enterActiveDisplay() {
        renderLine = renderLineActive;

        //logInfo("Active");
    }

    function enterBottomBorder() {
        renderLine = renderLineBorders;

        //logInfo("Bottom Border");
    }

    function updateLineActiveType() {
        var old = renderLineActive;
        renderLineActive = (register[1] & 0x40) ? debugModePatternInfo ? modeData.updLineDeb : modeData.updLine : renderLineActiveBlanked;
        if (renderLine === old) renderLine = renderLineActive;

        pendingBlankingChange = false;
    }

    function updateSpritesLineType() {
        renderSpritesLine =
              modeData.spriteMode === 2 ? (register[8] & 0x02) === 0 ? renderSpritesLineFunctionsMode2[register[1] & 0x03] : null       // SPD, SI, MAG
            : modeData.spriteMode === 1 ? renderSpritesLineFunctionsMode1[register[1] & 0x03]                                           // SI, MAG
            : null;

        //logInfo("SpriteType: " + (renderSpritesLine && renderSpritesLine.name));
    }

    function updateTransparency() {
        color0Solid = (register[8] & 0x20) !== 0;
        colorPalette[0] = color0Solid ? colorPalette[16] : backdropValue;

        //console.log("TP: " + color0Solid + ", currentLine: " + currentScanline);
    }

    function updateBackdropColor(forceValue) {
        backdropColor = register[7] & (mode === 7 ? 0xff : 0x0f);

        //console.log("Backdrop Color: " + backdropColor + ", currentLine: " + currentScanline);

        updateBackdropValue(forceValue);
    }

    function updateBackdropValue(force) {
        var value = debugModePatternInfo
            ? debugBackdropValue
            : mode === 7
                ? colors256[backdropColor]                   // From all 256 colors
                : colorPalette[backdropColor + 16];          // From current palette (solid regardless of TP)

        if (backdropValue === value && !force) return;

        backdropValue = value;
        if (!color0Solid && mode !== 7) colorPalette[0] = value;
        updateBackdropCaches();
    }

    function updateBackdropCaches() {

        //console.log("Update BackdropCaches");

        if (mode === 4 && !debugModePatternInfo) updateBackdropCachesG5();      // Special case for mode G5 (Screen 6)
        else wmsx.Util.arrayFill(backdropFullLine512Values, backdropValue);
    }

    function updateBackdropCachesG5() {
        var odd = colorPalette[backdropColor >>> 2]; var even = colorPalette[backdropColor & 0x03];
        for (var i = 0; i < LINE_WIDTH; i += 2) {
            backdropFullLine512Values[i] = odd; backdropFullLine512Values[i + 1] = even;
        }
    }

    function updateBlinking() {
        if ((register[13] >>> 4) === 0) {
            blinkEvenPage = false; blinkPageDuration = 0;        // Force page to be fixed on the Odd page
        } else if ((register[13] & 0x0f) === 0) {
            blinkEvenPage = true;  blinkPageDuration = 0;        // Force page to be fixed on the Even page
        } else {
            blinkEvenPage = true;  blinkPageDuration = 1;        // Force next page to be the Even page and let alternance start
        }
    }

    function updatePageAlternance() {
        alternativePageOffset = blinkEvenPage || ((register[9] & 0x04) && (status[2] & 0x02) === 0) ? -modeData.pageSize : 0;     // Consider EO (both register and flag)
    }

    function renderLineBorders() {
        frameBackBuffer.set(backdropFullLine512Values, bufferPosition);
        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineActiveBlanked() {
        frameBackBuffer.set(backdropFullLine512Values, bufferPosition);
        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeT1() {                                           // Text (Screen 0 width 40)
        var bufferPos = bufferPosition;

        paintBackdrop24(bufferPos); paintBackdrop24(bufferPos + 256 - 8);
        bufferPos = bufferPos + 16 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var patPos = layoutTableAddress + (realLine >>> 3) * 40;            // line / 8 * 40
        var patPosFinal = patPos + 40;
        var colorCode = register[7];                                        // fixed text color for all line
        var lineInPattern = patternTableAddress + (realLine & 0x07);
        var on =  colorPalette[colorCode >>> 4];
        var off = colorPalette[colorCode & 0xf];
        while (patPos < patPosFinal) {
            var name = vram[patPos++];                                      // no masking needed
            var pattern = vram[(name << 3) + lineInPattern];                // no masking needed
            paintPattern(bufferPos, pattern, on, off);
            bufferPos += 6;
        }

        // Sprites deactivated
        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeT2() {                                           // Text (Screen 0 width 80)
        var bufferPos = bufferPosition;

        paintBackdrop48(bufferPos); paintBackdrop48(bufferPos + 512 - 16);
        bufferPos = bufferPos + 32 + horizontalAdjust * 2;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var patPos = layoutTableAddress + (realLine >>> 3) * 80;            // line / 8 * 80
        var patPosFinal = patPos + 80;
        var lineInPattern = patternTableAddress + (realLine & 0x07);
        var name, pattern, colorCode, on, off;

        if (blinkEvenPage) {                                                // Blink only in Even page
            var blinkPos = colorTableAddress + (realLine >>> 3) * 10;
            var blinkBit = 7;
            while (patPos < patPosFinal) {
                var blink = (vram[blinkPos & colorTableAddressMask] >>> blinkBit) & 1;
                name = vram[patPos++ & layoutTableAddressMask];
                colorCode = register[blink ? 12 : 7];                       // special colors from register12 if blink bit for position is set
                pattern = vram[(name << 3) + lineInPattern];                // no masking needed
                on = colorPalette[(colorCode >>> 4) + (blink ? 16 : 0)];    // color 0 is always solid in blink];
                off = colorPalette[(colorCode & 0xf) + (blink ? 16 : 0)];
                paintPattern(bufferPos, pattern, on, off);
                if (--blinkBit < 0) { blinkPos++; blinkBit = 7; }
                bufferPos += 6;
            }
        } else {
            colorCode = register[7];
            on =  colorPalette[colorCode >>> 4];
            off = colorPalette[colorCode & 0xf];
            while (patPos < patPosFinal) {
                name = vram[patPos++ & layoutTableAddressMask];
                pattern = vram[(name << 3) + lineInPattern];                // no masking needed
                paintPattern(bufferPos, pattern, on, off);
                bufferPos += 6;
            }
        }

        // Sprites deactivated
        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeMC() {                                           // Multicolor (Screen 3)
        var bufferPos = bufferPosition;

        paintBackdrop16(bufferPos); paintBackdrop16(bufferPos + 256);
        bufferPos = bufferPos + 8 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var patPos = layoutTableAddress + ((realLine >>> 3) << 5);          // line / 8 * 32
        var patPosFinal = patPos + 32;
        var extraPatPos = patternTableAddress + (((realLine >>> 3) & 0x03) << 1) + ((realLine >> 2) & 0x01);    // (pattern line % 4) * 2
        while (patPos < patPosFinal) {
            var name = vram[patPos++];                                      // no masking needed
            var patternLine = (name << 3) + extraPatPos;                    // name * 8 + extra position, no masking needed
            var colorCode = vram[patternLine];                              // no masking needed
            var on =  colorPalette[colorCode >>> 4];
            var off = colorPalette[colorCode & 0xf];
            paintPattern(bufferPos, 0xf0, on, off);                 // always solid blocks of front and back colors;
            bufferPos += 8;
        }

        renderSpritesLine(realLine, bufferPos - 256);

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeG1() {                                           // Graphics 1 (Screen 1)
        var bufferPos = bufferPosition;

        paintBackdrop16(bufferPos); paintBackdrop16(bufferPos + 256);
        bufferPos = bufferPos + 8 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var patPos = layoutTableAddress + ((realLine >>> 3) << 5);          // line / 8 * 32
        var patPosFinal = patPos + 32;
        var lineInPattern = patternTableAddress + (realLine & 0x07);
        while (patPos < patPosFinal) {
            var name = vram[patPos++];                                      // no masking needed
            var colorCode = vram[colorTableAddress + (name >>> 3)];         // name / 8 (1 color for each 8 patterns), no masking needed
            var pattern = vram[((name << 3) + lineInPattern)];              // name * 8 (8 bytes each pattern) + line inside pattern, no masking needed
            var on =  colorPalette[colorCode >>> 4];
            var off = colorPalette[colorCode & 0xf];
            paintPattern(bufferPos, pattern, on, off);
            bufferPos += 8;
        }

        renderSpritesLine(realLine, bufferPos - 256);

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeG2() {                                           // Graphics 2 (Screen 2)
        var bufferPos = bufferPosition;

        paintBackdrop16(bufferPos); paintBackdrop16(bufferPos + 256);
        bufferPos = bufferPos + 8 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var patPos = layoutTableAddress + ((realLine >>> 3) << 5);          // line / 8 * 32
        var patPosFinal = patPos + 32;
        var lineInColor = colorTableAddress + (realLine & 0x07);
        var lineInPattern = patternTableAddress + (realLine & 0x07);
        var blockExtra = (realLine & 0xc0) << 2;                            // + 0x100 for each third block of the screen (8 pattern lines)
        while (patPos < patPosFinal) {
            var name = vram[patPos++] | blockExtra;                         // no masking needed
            var colorCode = vram[((name << 3) + lineInColor) & colorTableAddressMask];     // (8 bytes each pattern) + line inside pattern
            var pattern = vram[((name << 3) + lineInPattern) & patternTableAddressMask];
            var on =  colorPalette[colorCode >>> 4];
            var off = colorPalette[colorCode & 0xf];
            paintPattern(bufferPos, pattern, on, off);
            bufferPos += 8;
        }

        renderSpritesLine(realLine, bufferPos - 256);

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeG3() {                                           // Graphics 3 (Screen 4)
        var bufferPos = bufferPosition;

        paintBackdrop16(bufferPos); paintBackdrop16(bufferPos + 256);
        bufferPos = bufferPos + 8 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var patPos = layoutTableAddress + ((realLine >>> 3) << 5);          // line / 8 * 32
        var patPosFinal = patPos + 32;
        var lineInColor = colorTableAddress + (realLine & 0x07);
        var lineInPattern = patternTableAddress + (realLine & 0x07);
        var blockExtra = (realLine & 0xc0) << 2;                            // + 0x100 for each third block of the screen (8 pattern lines)
        while (patPos < patPosFinal) {
            var name = vram[patPos++] | blockExtra;                         // no masking needed
            var colorCode = vram[((name << 3) + lineInColor) & colorTableAddressMask];    // (8 bytes each pattern) + line inside pattern
            var pattern = vram[((name << 3) + lineInPattern) & patternTableAddressMask];
            var on =  colorPalette[colorCode >>> 4];
            var off = colorPalette[colorCode & 0xf];
            paintPattern(bufferPos, pattern, on, off);
            bufferPos += 8;
        }

        if (renderSpritesLine) renderSpritesLine(realLine, bufferPos - 256, colorPalette);

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeG4() {                                           // Graphics 4 (Screen 5)
        var bufferPos = bufferPosition;

        paintBackdrop16(bufferPos); paintBackdrop16(bufferPos + 256);
        bufferPos = bufferPos + 8 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var pixelsPos = layoutTableAddress + alternativePageOffset + (realLine << 7);
        var pixelsPosFinal = pixelsPos + 128;
        while (pixelsPos < pixelsPosFinal) {
            var pixels = vram[pixelsPos++ & layoutTableAddressMask];
            frameBackBuffer[bufferPos++] = colorPalette[pixels >>> 4];
            frameBackBuffer[bufferPos++] = colorPalette[pixels & 0x0f];
        }

        if (renderSpritesLine) renderSpritesLine(realLine, bufferPos - 256, colorPalette);

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeG5() {                                           // Graphics 5 (Screen 6)
        var bufferPos = bufferPosition;

        paintBackdrop32G5(bufferPos); paintBackdrop32G5(bufferPos + 512);
        bufferPos = bufferPos + 16 + horizontalAdjust * 2;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var pixelsPos = layoutTableAddress + alternativePageOffset + (realLine << 7);
        var pixelsPosFinal = pixelsPos + 128;
        while (pixelsPos < pixelsPosFinal) {
            var pixels = vram[pixelsPos++ & layoutTableAddressMask];
            frameBackBuffer[bufferPos++] = colorPalette[pixels >>> 6];
            frameBackBuffer[bufferPos++] = colorPalette[(pixels >>> 4) & 0x03];
            frameBackBuffer[bufferPos++] = colorPalette[(pixels >>> 2) & 0x03];
            frameBackBuffer[bufferPos++] = colorPalette[pixels & 0x03];
        }

        if (renderSpritesLine) renderSpritesLine(realLine, bufferPos - 512, colorPalette);      // TODO Render Sprites in mode G5

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeG6() {                                           // Graphics 6 (Screen 7)
        var bufferPos = bufferPosition;

        paintBackdrop32(bufferPos); paintBackdrop32(bufferPos + 512);
        bufferPos = bufferPos + 16 + horizontalAdjust * 2;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var pixelsPos = layoutTableAddress + alternativePageOffset + (realLine << 8);
        var pixelsPosFinal = pixelsPos + 256;
        while (pixelsPos < pixelsPosFinal) {
            var pixels = vram[pixelsPos++ & layoutTableAddressMask];
            frameBackBuffer[bufferPos++] = colorPalette[pixels >>> 4];
            frameBackBuffer[bufferPos++] = colorPalette[pixels & 0x0f];
        }

        if (renderSpritesLine) renderSpritesLine(realLine, bufferPos - 512, colorPalette);      // TODO Render Sprites in mode G6

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeG7() {                                           // Graphics 7 (Screen 8)
        var bufferPos = bufferPosition;

        paintBackdrop16(bufferPos); paintBackdrop16(bufferPos + 256);
        bufferPos = bufferPos + 8 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var pixelsPos = layoutTableAddress + alternativePageOffset + (realLine << 8);
        var pixelsPosFinal = pixelsPos + 256;
        while (pixelsPos < pixelsPosFinal) {
            frameBackBuffer[bufferPos++] = colors256[vram[pixelsPos++ & layoutTableAddressMask]];
        }

        if (renderSpritesLine) renderSpritesLine(realLine, bufferPos - 256, colorPaletteG7);        // Special fixed palette

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeT1Debug() {                                      // Text (Screen 0)
        var bufferPos = bufferPosition;

        paintBackdrop24(bufferPos); paintBackdrop24(bufferPos + 256 - 8);
        bufferPos = bufferPos + 16 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var patPos = layoutTableAddress + ((realLine >>> 3) * 40);          // line / 8 * 40
        var patPosFinal = patPos + 40;
        var lineInPattern = realLine & 0x07;
        while (patPos < patPosFinal) {
            var name = vram[patPos++];
            if (debugModePatternInfoNames) {
                var colorCode = name === 0x20 ? 0x41 : 0xf1;
                var pattern = debugPatTableDigits8[name * 8 + lineInPattern];
                // Squish digits to fit 6 pixels wide
                if (lineInPattern <= 5) {
                    pattern = (pattern & 0xe0) | ((pattern & 0x0e) << 1);   // TODO Darken 2nd digit
                } else if (lineInPattern === 6)
                    pattern = 0x78;
            } else if (debugModePatternInfoBlocks) {
                colorCode = register[7];                                    // Real text color for all blocks
                pattern = debugPatTableBlocks[lineInPattern];
            } else {
                colorCode = 0xf1;
                pattern = vram[patternTableAddress + (name << 3) + lineInPattern];
            }
            var on =  colorPalette[colorCode >>> 4];
            var off = colorPalette[colorCode & 0xf];
            paintPattern(bufferPos, pattern, on, off);
            bufferPos += 6;
        }

        // Sprites deactivated

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeMCDebug() {                                      // Multicolor (Screen 3)
        if (!debugModePatternInfoNames) return renderLineModeMC();

        var bufferPos = bufferPosition;

        paintBackdrop16(bufferPos); paintBackdrop16(bufferPos + 256);
        bufferPos = bufferPos + 8 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var patPos = layoutTableAddress + ((realLine >>> 3) << 5);          // line / 8 * 32
        var patPosFinal = patPos + 32;
        while (patPos < patPosFinal) {
            var name = vram[patPos++];
            var pattern = debugPatTableDigits8[name * 8 + (realLine & 0x07)];
            var colorCode = 0xf1;
            var on =  colorPalette[colorCode >>> 4];
            var off = colorPalette[colorCode & 0xf];
            paintPattern(bufferPos, pattern, on, off);
            bufferPos += 8;
        }

        renderSpritesLine(realLine, bufferPos - 256);

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeG1Debug() {                                      // Graphics 1 (Screen 1)
        var bufferPos = bufferPosition;

        paintBackdrop16(bufferPos); paintBackdrop16(bufferPos + 256);
        bufferPos = bufferPos + 8 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var patPos = layoutTableAddress + ((realLine >>> 3) << 5);
        var patPosFinal = patPos + 32;
        var lineInPattern = realLine & 0x07;
        while (patPos < patPosFinal) {
            var name = vram[patPos++];
            if (debugModePatternInfoNames) {
                var colorCode = name === 0 || name === 0x20 ? 0x41 : 0xf1;
                var pattern = debugPatTableDigits8[name * 8 + lineInPattern];
            } else if (debugModePatternInfoBlocks) {
                colorCode = vram[colorTableAddress + (name >>> 3)];
                pattern = debugPatTableBlocks[lineInPattern];
            } else {
                colorCode = 0xf1;
                pattern = vram[patternTableAddress + (name << 3) + lineInPattern];
            }
            var on =  colorPalette[colorCode >>> 4];
            var off = colorPalette[colorCode & 0xf];
            paintPattern(bufferPos, pattern, on, off);
            bufferPos += 8;
        }

        renderSpritesLine(realLine, bufferPos - 256);

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function renderLineModeG2Debug() {                                      // Graphics 2 (Screen 2)
        var bufferPos = bufferPosition;

        paintBackdrop16(bufferPos); paintBackdrop16(bufferPos + 256);
        bufferPos = bufferPos + 8 + horizontalAdjust;

        var realLine = (currentScanline - startingActiveScanline + register[23]) & 255;
        var lineInPattern = realLine & 0x07;
        var blockExtra = (realLine & 0xc0) << 2;
        var patPos = layoutTableAddress + ((realLine >>> 3) << 5);
        var patPosFinal = patPos + 32;
        while (patPos < patPosFinal) {
            var name = vram[patPos++] | blockExtra;
            if (debugModePatternInfoNames) {
                name &= 0xff;
                var colorCode = name === 0 || name === 0x20 ? 0x41 : 0xf1;
                var pattern = debugPatTableDigits8[name * 8 + lineInPattern];
            } else if (debugModePatternInfoBlocks) {
                colorCode = vram[(colorTableAddress + (name << 3) + lineInPattern) & colorTableAddressMask];
                pattern = debugPatTableBlocks[lineInPattern];
            } else {
                colorCode = 0xf1;
                pattern = vram[(patternTableAddress + (name << 3) + lineInPattern) & patternTableAddressMask];
            }
            var on =  colorPalette[colorCode >>> 4];
            var off = colorPalette[colorCode & 0xf];
            paintPattern(bufferPos, pattern, on, off);
            bufferPos += 8;
        }

        renderSpritesLine(realLine, bufferPos - 256);

        bufferPosition = bufferPosition + bufferLineAdvance;
    }

    function paintPattern(bufferPos, pattern, on, off) {
        frameBackBuffer[bufferPos]     = pattern & 0x80 ? on : off; frameBackBuffer[bufferPos + 1] = pattern & 0x40 ? on : off; frameBackBuffer[bufferPos + 2] = pattern & 0x20 ? on : off; frameBackBuffer[bufferPos + 3] = pattern & 0x10 ? on : off;
        frameBackBuffer[bufferPos + 4] = pattern & 0x08 ? on : off; frameBackBuffer[bufferPos + 5] = pattern & 0x04 ? on : off; frameBackBuffer[bufferPos + 6] = pattern & 0x02 ? on : off; frameBackBuffer[bufferPos + 7] = pattern & 0x01 ? on : off;
    }

    function paintBackdrop8(bufferPos) {
        frameBackBuffer[bufferPos]     = backdropValue; frameBackBuffer[bufferPos + 1] = backdropValue; frameBackBuffer[bufferPos + 2] = backdropValue; frameBackBuffer[bufferPos + 3] = backdropValue;
        frameBackBuffer[bufferPos + 4] = backdropValue; frameBackBuffer[bufferPos + 5] = backdropValue; frameBackBuffer[bufferPos + 6] = backdropValue; frameBackBuffer[bufferPos + 7] = backdropValue;
    }

    function paintBackdrop16(bufferPos) {
        frameBackBuffer[bufferPos]      = backdropValue; frameBackBuffer[bufferPos +  1] = backdropValue; frameBackBuffer[bufferPos +  2] = backdropValue; frameBackBuffer[bufferPos +  3] = backdropValue;
        frameBackBuffer[bufferPos +  4] = backdropValue; frameBackBuffer[bufferPos +  5] = backdropValue; frameBackBuffer[bufferPos +  6] = backdropValue; frameBackBuffer[bufferPos +  7] = backdropValue;
        frameBackBuffer[bufferPos +  8] = backdropValue; frameBackBuffer[bufferPos +  9] = backdropValue; frameBackBuffer[bufferPos + 10] = backdropValue; frameBackBuffer[bufferPos + 11] = backdropValue;
        frameBackBuffer[bufferPos + 12] = backdropValue; frameBackBuffer[bufferPos + 13] = backdropValue; frameBackBuffer[bufferPos + 14] = backdropValue; frameBackBuffer[bufferPos + 15] = backdropValue;
    }

    function paintBackdrop24(bufferPos) {
        frameBackBuffer[bufferPos]      = backdropValue; frameBackBuffer[bufferPos +  1] = backdropValue; frameBackBuffer[bufferPos +  2] = backdropValue; frameBackBuffer[bufferPos +  3] = backdropValue;
        frameBackBuffer[bufferPos +  4] = backdropValue; frameBackBuffer[bufferPos +  5] = backdropValue; frameBackBuffer[bufferPos +  6] = backdropValue; frameBackBuffer[bufferPos +  7] = backdropValue;
        frameBackBuffer[bufferPos +  8] = backdropValue; frameBackBuffer[bufferPos +  9] = backdropValue; frameBackBuffer[bufferPos + 10] = backdropValue; frameBackBuffer[bufferPos + 11] = backdropValue;
        frameBackBuffer[bufferPos + 12] = backdropValue; frameBackBuffer[bufferPos + 13] = backdropValue; frameBackBuffer[bufferPos + 14] = backdropValue; frameBackBuffer[bufferPos + 15] = backdropValue;
        frameBackBuffer[bufferPos + 16] = backdropValue; frameBackBuffer[bufferPos + 17] = backdropValue; frameBackBuffer[bufferPos + 18] = backdropValue; frameBackBuffer[bufferPos + 19] = backdropValue;
        frameBackBuffer[bufferPos + 20] = backdropValue; frameBackBuffer[bufferPos + 21] = backdropValue; frameBackBuffer[bufferPos + 22] = backdropValue; frameBackBuffer[bufferPos + 23] = backdropValue;
    }

    function paintBackdrop32(bufferPos) {
        frameBackBuffer[bufferPos]      = backdropValue; frameBackBuffer[bufferPos +  1] = backdropValue; frameBackBuffer[bufferPos +  2] = backdropValue; frameBackBuffer[bufferPos +  3] = backdropValue;
        frameBackBuffer[bufferPos +  4] = backdropValue; frameBackBuffer[bufferPos +  5] = backdropValue; frameBackBuffer[bufferPos +  6] = backdropValue; frameBackBuffer[bufferPos +  7] = backdropValue;
        frameBackBuffer[bufferPos +  8] = backdropValue; frameBackBuffer[bufferPos +  9] = backdropValue; frameBackBuffer[bufferPos + 10] = backdropValue; frameBackBuffer[bufferPos + 11] = backdropValue;
        frameBackBuffer[bufferPos + 12] = backdropValue; frameBackBuffer[bufferPos + 13] = backdropValue; frameBackBuffer[bufferPos + 14] = backdropValue; frameBackBuffer[bufferPos + 15] = backdropValue;
        frameBackBuffer[bufferPos + 16] = backdropValue; frameBackBuffer[bufferPos + 17] = backdropValue; frameBackBuffer[bufferPos + 18] = backdropValue; frameBackBuffer[bufferPos + 19] = backdropValue;
        frameBackBuffer[bufferPos + 20] = backdropValue; frameBackBuffer[bufferPos + 21] = backdropValue; frameBackBuffer[bufferPos + 22] = backdropValue; frameBackBuffer[bufferPos + 23] = backdropValue;
        frameBackBuffer[bufferPos + 24] = backdropValue; frameBackBuffer[bufferPos + 25] = backdropValue; frameBackBuffer[bufferPos + 26] = backdropValue; frameBackBuffer[bufferPos + 27] = backdropValue;
        frameBackBuffer[bufferPos + 28] = backdropValue; frameBackBuffer[bufferPos + 29] = backdropValue; frameBackBuffer[bufferPos + 30] = backdropValue; frameBackBuffer[bufferPos + 31] = backdropValue;
    }

    function paintBackdrop48(bufferPos) {
        frameBackBuffer[bufferPos]      = backdropValue; frameBackBuffer[bufferPos +  1] = backdropValue; frameBackBuffer[bufferPos +  2] = backdropValue; frameBackBuffer[bufferPos +  3] = backdropValue;
        frameBackBuffer[bufferPos +  4] = backdropValue; frameBackBuffer[bufferPos +  5] = backdropValue; frameBackBuffer[bufferPos +  6] = backdropValue; frameBackBuffer[bufferPos +  7] = backdropValue;
        frameBackBuffer[bufferPos +  8] = backdropValue; frameBackBuffer[bufferPos +  9] = backdropValue; frameBackBuffer[bufferPos + 10] = backdropValue; frameBackBuffer[bufferPos + 11] = backdropValue;
        frameBackBuffer[bufferPos + 12] = backdropValue; frameBackBuffer[bufferPos + 13] = backdropValue; frameBackBuffer[bufferPos + 14] = backdropValue; frameBackBuffer[bufferPos + 15] = backdropValue;
        frameBackBuffer[bufferPos + 16] = backdropValue; frameBackBuffer[bufferPos + 17] = backdropValue; frameBackBuffer[bufferPos + 18] = backdropValue; frameBackBuffer[bufferPos + 19] = backdropValue;
        frameBackBuffer[bufferPos + 20] = backdropValue; frameBackBuffer[bufferPos + 21] = backdropValue; frameBackBuffer[bufferPos + 22] = backdropValue; frameBackBuffer[bufferPos + 23] = backdropValue;
        frameBackBuffer[bufferPos + 24] = backdropValue; frameBackBuffer[bufferPos + 25] = backdropValue; frameBackBuffer[bufferPos + 26] = backdropValue; frameBackBuffer[bufferPos + 27] = backdropValue;
        frameBackBuffer[bufferPos + 28] = backdropValue; frameBackBuffer[bufferPos + 29] = backdropValue; frameBackBuffer[bufferPos + 30] = backdropValue; frameBackBuffer[bufferPos + 31] = backdropValue;
        frameBackBuffer[bufferPos + 32] = backdropValue; frameBackBuffer[bufferPos + 33] = backdropValue; frameBackBuffer[bufferPos + 34] = backdropValue; frameBackBuffer[bufferPos + 35] = backdropValue;
        frameBackBuffer[bufferPos + 36] = backdropValue; frameBackBuffer[bufferPos + 37] = backdropValue; frameBackBuffer[bufferPos + 38] = backdropValue; frameBackBuffer[bufferPos + 39] = backdropValue;
        frameBackBuffer[bufferPos + 40] = backdropValue; frameBackBuffer[bufferPos + 41] = backdropValue; frameBackBuffer[bufferPos + 42] = backdropValue; frameBackBuffer[bufferPos + 43] = backdropValue;
        frameBackBuffer[bufferPos + 44] = backdropValue; frameBackBuffer[bufferPos + 45] = backdropValue; frameBackBuffer[bufferPos + 46] = backdropValue; frameBackBuffer[bufferPos + 47] = backdropValue;
    }

    function paintBackdrop32G5(bufferPos) {
        var odd =  backdropFullLine512Values[0]; var even = backdropFullLine512Values[1];
        frameBackBuffer[bufferPos]      = odd; frameBackBuffer[bufferPos +  1] = even; frameBackBuffer[bufferPos +  2] = odd; frameBackBuffer[bufferPos +  3] = even;
        frameBackBuffer[bufferPos +  4] = odd; frameBackBuffer[bufferPos +  5] = even; frameBackBuffer[bufferPos +  6] = odd; frameBackBuffer[bufferPos +  7] = even;
        frameBackBuffer[bufferPos +  8] = odd; frameBackBuffer[bufferPos +  9] = even; frameBackBuffer[bufferPos + 10] = odd; frameBackBuffer[bufferPos + 11] = even;
        frameBackBuffer[bufferPos + 12] = odd; frameBackBuffer[bufferPos + 13] = even; frameBackBuffer[bufferPos + 14] = odd; frameBackBuffer[bufferPos + 15] = even;
        frameBackBuffer[bufferPos + 16] = odd; frameBackBuffer[bufferPos + 17] = even; frameBackBuffer[bufferPos + 18] = odd; frameBackBuffer[bufferPos + 19] = even;
        frameBackBuffer[bufferPos + 20] = odd; frameBackBuffer[bufferPos + 21] = even; frameBackBuffer[bufferPos + 22] = odd; frameBackBuffer[bufferPos + 23] = even;
        frameBackBuffer[bufferPos + 24] = odd; frameBackBuffer[bufferPos + 25] = even; frameBackBuffer[bufferPos + 26] = odd; frameBackBuffer[bufferPos + 27] = even;
        frameBackBuffer[bufferPos + 28] = odd; frameBackBuffer[bufferPos + 29] = even; frameBackBuffer[bufferPos + 30] = odd; frameBackBuffer[bufferPos + 31] = even;
    }

    function renderSprites1LineSize0(line, bufferPos) {                     // Mode 1, 8x8 normal
        if (vram[spriteAttrTableAddress] === 208) return;                   // No sprites to show!

        var atrPos, name, color, lineInPattern, pattern;
        var sprite = -1, drawn = 0, y, spriteLine, x, s, f;

        spritesGlobalPriority -= 32;

        atrPos = spriteAttrTableAddress - 4;
        for (var i = 0; i < 32; i = i + 1) {                                // Max of 32 sprites
            atrPos = atrPos + 4;
            sprite = sprite + 1;
            y = vram[atrPos];
            if (y === 208) break;                                           // Stop Sprite processing for the line, as per spec
            spriteLine = (line - y - 1) & 255;
            if (spriteLine > 7) continue;                                   // Not visible at line
            if (++drawn > 4) {                                              // Max of 4 sprites drawn. Store the first invalid (5th)
                if (spritesInvalid < 0) spritesInvalid = sprite;
                if (spriteDebugModeLimit) return;
            }
            x = vram[atrPos + 1];
            color = vram[atrPos + 3];
            if (color & 0x80) {
                x -= 32;                                                    // Early Clock bit, X to be 32 to the left
                if (x < -7) continue;                                       // Not visible (out to the left)
            }
            color &= 0x0f;
            name = vram[atrPos + 2];
            lineInPattern = spritePatternTableAddress + (name << 3) + spriteLine;
            pattern = vram[lineInPattern];
            s = x <= 248 ? 0 : x - 248;
            f = x >= 0 ? 8 : 8 + x;
            x += (8 - f);
            paintSprite1(x, line, bufferPos + x, spritesGlobalPriority + sprite, pattern, color, s, f, drawn < 5);
        }
        if (spritesInvalid < 0 && sprite > spritesMaxComputed) spritesMaxComputed = sprite;
    }

    function renderSprites1LineSize1(line, bufferPos) {                     // Mode 1, 8x8 double
        if (vram[spriteAttrTableAddress] === 208) return;                   // No sprites to show!

        var atrPos, name, color, lineInPattern, pattern;
        var sprite = -1, drawn = 0, y, spriteLine, x, s, f;

        spritesGlobalPriority -= 32;

        atrPos = spriteAttrTableAddress - 4;
        for (var i = 0; i < 32; i = i + 1) {                                // Max of 32 sprites
            atrPos = atrPos + 4;
            sprite = sprite + 1;
            y = vram[atrPos];
            if (y === 208) break;                                           // Stop Sprite processing for the line, as per spec
            spriteLine = (line - y - 1) & 255;
            if (spriteLine > 15) continue;                                  // Not visible at line
            if (++drawn > 4) {                                              // Max of 4 sprites drawn. Store the first invalid (5th)
                if (spritesInvalid < 0) spritesInvalid = sprite;
                if (spriteDebugModeLimit) return;
            }
            x = vram[atrPos + 1];
            color = vram[atrPos + 3];
            if (color & 0x80) x -= 32;                                      // Early Clock bit, X to be 32 to the left
            if (color & 0x80) {
                x -= 32;                                                    // Early Clock bit, X to be 32 to the left
                if (x < -15) continue;                                      // Not visible (out to the left)
            }
            name = vram[atrPos + 2];
            lineInPattern = spritePatternTableAddress + (name << 3) + (spriteLine >>> 1);    // Double line height
            pattern = vram[lineInPattern];
            s = x <= 240 ? 0 : x - 240;
            f = x >= 0 ? 16 : 16 + x;
            x += (16 - f);
            paintSprite1D(x, line, bufferPos + x, spritesGlobalPriority + sprite, pattern, color, s, f, drawn < 5);
        }
        if (spritesInvalid < 0 && sprite > spritesMaxComputed) spritesMaxComputed = sprite;
    }

    function renderSprites1LineSize2(line, bufferPos) {                     // Mode 1, 16x16 normal
        if (vram[spriteAttrTableAddress] === 208) return;                   // No sprites to show!

        var atrPos, color, name, lineInPattern, pattern;
        var sprite = -1, drawn = 0, y, spriteLine, x, s, f;

        spritesGlobalPriority -= 32;

        atrPos = spriteAttrTableAddress - 4;
        for (var i = 0; i < 32; i = i + 1) {                                // Max of 32 sprites
            atrPos = atrPos + 4;
            sprite = sprite + 1;
            y = vram[atrPos];
            if (y === 208) break;                                           // Stop Sprite processing for the line, as per spec
            spriteLine = (line - y - 1) & 255;
            if (spriteLine > 15) continue;                                  // Not visible at line
            if (++drawn > 4) {                                              // Max of 4 sprites drawn. Store the first invalid (5th)
                if (spritesInvalid < 0) spritesInvalid = sprite;
                if (spriteDebugModeLimit) return;
            }
            x = vram[atrPos + 1];
            color = vram[atrPos + 3];
            if (color & 0x80) {
                x -= 32;                                                    // Early Clock bit, X to be 32 to the left
                if (x < -15) continue;                                      // Not visible (out to the left)
            }
            color &= 0x0f;
            name = vram[atrPos + 2];
            lineInPattern = spritePatternTableAddress + ((name & 0xfc) << 3) + spriteLine;
            pattern = (vram[lineInPattern] << 8) | vram[lineInPattern + 16];
            s = x <= 240 ? 0 : x - 240;
            f = x >= 0 ? 16 : 16 + x;
            x += (16 - f);
            paintSprite1(x, line, bufferPos + x, spritesGlobalPriority + sprite, pattern, color, s, f, drawn < 5);
        }
        if (spritesInvalid < 0 && sprite > spritesMaxComputed) spritesMaxComputed = sprite;
    }

    function renderSprites1LineSize3(line, bufferPos) {                     // Mode 1, 16x16 double
        if (vram[spriteAttrTableAddress] === 208) return;                   // No sprites to show!

        var atrPos, name, color, lineInPattern, pattern;
        var sprite = -1, drawn = 0, y, spriteLine, x, s, f;

        spritesGlobalPriority -= 32;

        atrPos = spriteAttrTableAddress - 4;
        for (var i = 0; i < 32; i = i + 1) {                                // Max of 32 sprites
            atrPos = atrPos + 4;
            sprite = sprite + 1;
            y = vram[atrPos];
            if (y === 208) break;                                           // Stop Sprite processing for the line, as per spec
            spriteLine = (line - y - 1) & 255;
            if (spriteLine > 31) continue;                                  // Not visible at line
            if (++drawn > 4) {                                              // Max of 4 sprites drawn. Store the first invalid (5th)
                if (spritesInvalid < 0) spritesInvalid = sprite;
                if (spriteDebugModeLimit) return;
            }
            x = vram[atrPos + 1];
            color = vram[atrPos + 3];
            if (color & 0x80) {
                x -= 32;                                                    // Early Clock bit, X to be 32 to the left
                if (x < -31) continue;                                      // Not visible (out to the left)
            }
            color &= 0x0f;
            name = vram[atrPos + 2];
            lineInPattern = spritePatternTableAddress + ((name & 0xfc) << 3) + (spriteLine >>> 1);    // Double line height
            pattern = (vram[lineInPattern] << 8) | vram[lineInPattern + 16];
            s = x <= 224 ? 0 : x - 224;
            f = x >= 0 ? 32 : 32 + x;
            x += (32 - f);
            paintSprite1D(x, line, bufferPos + x, spritesGlobalPriority + sprite, pattern, color, s, f, drawn < 5);
        }
        if (spritesInvalid < 0 && sprite > spritesMaxComputed) spritesMaxComputed = sprite;
    }

    function paintSprite1(x, y, bufferPos, spritePri, pattern, color, start, finish, collide) {
        for (var i = finish - 1; i >= start; i = i - 1, x = x + 1, bufferPos = bufferPos + 1) {
            var s = (pattern >> i) & 0x01;
            if (s === 0) continue;
            if (spritesLinePriorities[x] < spritePri) {                                     // Higher priority sprite already there
                if (collide && !spritesCollided) setSpritesCollision(x, y);
                if (color !== 0 && spritesLineColors[x] === 0) {                            // Paint only if not transparent and higher priority was transparent
                    spritesLineColors[x] = color;                                           // Register new color
                    frameBackBuffer[bufferPos] = colorPalette[color];
                }
            } else {                                                                        // No higher priority there
                spritesLinePriorities[x] = spritePri;                                       // Register new priority
                spritesLineColors[x] = color;                                               // Register new color
                if (color !== 0) frameBackBuffer[bufferPos] = colorPalette[color];          // Paint only if not transparent
            }
        }
    }

    function paintSprite1D(x, y, bufferPos, spritePri, pattern, color, start, finish, collide) {
        for (var i = finish - 1; i >= start; i = i -1, bufferPos = bufferPos + 1) {
            var s = (pattern >> (i >>> 1)) & 0x01;
            if (s === 0) continue;
            if (spritesLinePriorities[x] < spritePri) {                                     // Higher priority sprite already there
                if (collide && !spritesCollided) setSpritesCollision(x, y);
                if (color !== 0 && spritesLineColors[x] === 0) {                            // Paint only if not transparent and higher priority was transparent
                    spritesLineColors[x] = color;                                           // Register new color
                    frameBackBuffer[bufferPos] = colorPalette[color];
                }
            } else {                                                                        // No higher priority there
                spritesLinePriorities[x] = spritePri;                                       // Register new priority
                spritesLineColors[x] = color;                                               // Register new color
                if (color !== 0) frameBackBuffer[bufferPos] = colorPalette[color];          // Paint only if not transparent
            }
        }
    }

    function renderSprites2LineSize0(line, bufferPos, palette) {            // Mode 2, 8x8 normal
        if (vram[spriteAttrTableAddress + 512] === 216) return;             // No sprites to show!

        var atrPos, colorPos, color, name, lineInPattern, pattern;
        var sprite = -1, spritePri = SPRITE_MAX_PRIORITY, drawn = 0, y, spriteLine, x, s, f, cc;

        spritesGlobalPriority -= 32;

        atrPos = spriteAttrTableAddress + 512 - 4;
        colorPos = spriteAttrTableAddress - 16;
        for (var i = 0; i < 32; i = i + 1) {                                // Max of 32 sprites
            sprite = sprite + 1;
            atrPos = atrPos + 4;
            colorPos = colorPos + 16;
            y = vram[atrPos];
            if (y === 216) break;                                           // Stop Sprite processing for the line, as per spec
            spriteLine = (line - y - 1) & 255;
            if (spriteLine > 7) continue;                                   // Not visible at line

            color = vram[colorPos + spriteLine];
            cc = (color & 0x40);
            if (cc) {
                if (spritePri === SPRITE_MAX_PRIORITY) continue;            // Must have a higher priority Main Sprite (CC = 0) to show this one
            } else spritePri = spritesGlobalPriority + sprite;

            if (++drawn > 8) {                                              // Max of 8 sprites drawn. Store the first invalid (9th)
                if (spritesInvalid < 0) spritesInvalid = sprite;
                if (spriteDebugModeLimit) return;
            }

            if ((color & 0xf) === 0 && !color0Solid) continue;              // Nothing to paint. Consider TP

            x = vram[atrPos + 1];
            if (color & 0x80) {
                x -= 32;                                                    // Early Clock bit, X to be 32 to the left
                if (x < -7) continue;                                       // Not visible (out to the left)
            }
            name = vram[atrPos + 2];
            lineInPattern = spritePatternTableAddress + (name << 3) + spriteLine;
            pattern = vram[lineInPattern];
            s = x <= 248 ? 0 : x - 248;
            f = x >= 0 ? 8 : 8 + x;
            x += (8 - f);
            if (cc)
                paintSprite2CC(x, bufferPos + x, spritePri, pattern, color & 0xf, palette, s, f);
            else
                paintSprite2(x, line, bufferPos + x, spritePri, pattern, color & 0xf, palette, s, f, ((color & 0x20) === 0) && (drawn < 9));       // Consider IC
        }
        if (spritesInvalid < 0 && sprite > spritesMaxComputed) spritesMaxComputed = sprite;
    }

    function renderSprites2LineSize1(line, bufferPos, palette) {            // Mode 2, 8x8 double
        if (vram[spriteAttrTableAddress + 512] === 216) return;             // No sprites to show!

        var atrPos, colorPos, color, name, lineInPattern, pattern;
        var sprite = -1, spritePri = SPRITE_MAX_PRIORITY, drawn = 0, y, spriteLine, x, s, f, cc;

        spritesGlobalPriority -= 32;

        atrPos = spriteAttrTableAddress + 512 - 4;
        colorPos = spriteAttrTableAddress - 16;
        for (var i = 0; i < 32; i = i + 1) {                                // Max of 32 sprites
            sprite = sprite + 1;
            atrPos = atrPos + 4;
            colorPos = colorPos + 16;
            y = vram[atrPos];
            if (y === 216) break;                                           // Stop Sprite processing for the line, as per spec
            spriteLine = (line - y - 1) & 255;
            if (spriteLine > 15) continue;                                  // Not visible at line

            color = vram[colorPos + (spriteLine >>> 1)];                    // Double line height
            cc = (color & 0x40);
            if (cc) {
                if (spritePri === SPRITE_MAX_PRIORITY) continue;            // Must have a higher priority Main Sprite (CC = 0) to show this one
            } else spritePri = spritesGlobalPriority + sprite;

            if (++drawn > 8) {                                              // Max of 8 sprites drawn. Store the first invalid (9th)
                if (spritesInvalid < 0) spritesInvalid = sprite;
                if (spriteDebugModeLimit) return;
            }

            if ((color & 0xf) === 0 && !color0Solid) continue;              // Nothing to paint. Consider TP

            x = vram[atrPos + 1];
            if (color & 0x80) {
                x -= 32;                                                    // Early Clock bit, X to be 32 to the left
                if (x < -15) continue;                                      // Not visible (out to the left)
            }
            name = vram[atrPos + 2];
            lineInPattern = spritePatternTableAddress + (name << 3) + (spriteLine >>> 1);    // Double line height
            pattern = vram[lineInPattern];
            s = x <= 240 ? 0 : x - 240;
            f = x >= 0 ? 16 : 16 + x;
            x += (16 - f);
            if (cc)
                paintSprite2DCC(x, bufferPos + x, spritePri, pattern, color & 0xf, palette, s, f);
            else
                paintSprite2D(x, line, bufferPos + x, spritePri, pattern, color & 0xf, palette, s, f, ((color & 0x20) === 0) && (drawn < 9));       // Consider IC
        }
        if (spritesInvalid < 0 && sprite > spritesMaxComputed) spritesMaxComputed = sprite;
    }

    function renderSprites2LineSize2(line, bufferPos, palette)  {           // Mode 2, 16x16 normal
        if (vram[spriteAttrTableAddress + 512] === 216) return;             // No sprites to show!

        var atrPos, colorPos, color, name, lineInPattern, pattern;
        var sprite = -1, spritePri = SPRITE_MAX_PRIORITY, drawn = 0, y, spriteLine, x, s, f, cc;

        spritesGlobalPriority -= 32;

        atrPos = spriteAttrTableAddress + 512 - 4;
        colorPos = spriteAttrTableAddress - 16;
        for (var i = 0; i < 32; i = i + 1) {                                // Max of 32 sprites
            sprite = sprite + 1;
            atrPos = atrPos + 4;
            colorPos = colorPos + 16;
            y = vram[atrPos];
            if (y === 216) break;                                           // Stop Sprite processing for the line, as per spec
            spriteLine = (line - y - 1) & 255;
            if (spriteLine > 15) continue;                                  // Not visible at line

            color = vram[colorPos + spriteLine];
            cc = (color & 0x40);
            if (cc) {
                if (spritePri === SPRITE_MAX_PRIORITY) continue;            // Must have a higher priority Main Sprite (CC = 0) to show this one
            } else spritePri = spritesGlobalPriority + sprite;

            if (++drawn > 8) {                                              // Max of 8 sprites drawn. Store the first invalid (9th)
                if (spritesInvalid < 0) spritesInvalid = sprite;
                if (spriteDebugModeLimit) return;
            }

            if ((color & 0xf) === 0 && !color0Solid) continue;              // Nothing to paint. Consider TP

            x = vram[atrPos + 1];
            if (color & 0x80) {
                x -= 32;                                                    // Early Clock bit, X to be 32 to the left
                if (x < -15) continue;                                      // Not visible (out to the left)
            }
            name = vram[atrPos + 2];
            lineInPattern = spritePatternTableAddress + ((name & 0xfc) << 3) + spriteLine;
            pattern = (vram[lineInPattern] << 8) | vram[lineInPattern + 16];
            s = x <= 240 ? 0 : x - 240;
            f = x >= 0 ? 16 : 16 + x;
            x += (16 - f);
            if (cc)
                paintSprite2CC(x, bufferPos + x, spritePri, pattern, color & 0xf, palette, s, f);
            else
                paintSprite2(x, line, bufferPos + x, spritePri, pattern, color & 0xf, palette, s, f, ((color & 0x20) === 0) && (drawn < 9));       // Consider IC
        }
        if (spritesInvalid < 0 && sprite > spritesMaxComputed) spritesMaxComputed = sprite;
    }

    function renderSprites2LineSize3(line, bufferPos, palette) {            // Mode 2, 16x16 double
        if (vram[spriteAttrTableAddress + 512] === 216) return;             // No sprites to show!

        var atrPos, colorPos, color, name, lineInPattern, pattern;
        var sprite = -1, spritePri = SPRITE_MAX_PRIORITY, drawn = 0, y, spriteLine, x, s, f, cc;

        spritesGlobalPriority -= 32;

        atrPos = spriteAttrTableAddress + 512 - 4;
        colorPos = spriteAttrTableAddress - 16;
        for (var i = 0; i < 32; i = i + 1) {                                // Max of 32 sprites
            sprite = sprite + 1;
            atrPos = atrPos + 4;
            colorPos = colorPos + 16;
            y = vram[atrPos];
            if (y === 216) break;                                           // Stop Sprite processing for the line, as per spec
            spriteLine = (line - y - 1) & 255;
            if (spriteLine > 31) continue;                                  // Not visible at line

            color = vram[colorPos + (spriteLine >>> 1)];                    // Double line height
            cc = (color & 0x40);
            if (cc) {
                if (spritePri === SPRITE_MAX_PRIORITY) continue;            // Must have a higher priority Main Sprite (CC = 0) to show this one
            } else spritePri = spritesGlobalPriority + sprite;

            if (++drawn > 8) {                                              // Max of 8 sprites drawn. Store the first invalid (9th)
                if (spritesInvalid < 0) spritesInvalid = sprite;
                if (spriteDebugModeLimit) return;
            }

            if ((color & 0xf) === 0 && !color0Solid) continue;              // Nothing to paint. Consider TP

            x = vram[atrPos + 1];
            if (color & 0x80) {
                x -= 32;                                                    // Early Clock bit, X to be 32 to the left
                if (x < -31) continue;                                      // Not visible (out to the left)
            }
            name = vram[atrPos + 2];
            lineInPattern = spritePatternTableAddress + ((name & 0xfc) << 3) + (spriteLine >>> 1);    // Double line height
            pattern = (vram[lineInPattern] << 8) | vram[lineInPattern + 16];
            s = x <= 224 ? 0 : x - 224;
            f = x >= 0 ? 32 : 32 + x;
            x += (32 - f);
            if (cc)
                paintSprite2DCC(x, bufferPos + x, spritePri, pattern, color & 0xf, palette, s, f);
            else
                paintSprite2D(x, line, bufferPos + x, spritePri, pattern, color & 0xf, palette, s, f, ((color & 0x20) === 0) && (drawn < 9));       // Consider IC
        }
        if (spritesInvalid < 0 && sprite > spritesMaxComputed) spritesMaxComputed = sprite;
    }

    function paintSprite2(x, y, bufferPos, spritePri, pattern, color, palette, start, finish, collide) {
        for (var i = finish - 1; i >= start; i = i - 1, x = x + 1, bufferPos = bufferPos + 1) {
            var s = (pattern >> i) & 0x01;
            if (s === 0) continue;
            if (spritesLinePriorities[x] < spritePri) {                                     // Higher priority sprite already there
                if (collide && !spritesCollided) setSpritesCollision(x, y);
                continue;
            }
            spritesLinePriorities[x] = spritePri;                                           // Register new priority
            spritesLineColors[x] = color;                                                   // Register new color
            frameBackBuffer[bufferPos] = palette[color];
        }
    }

    function paintSprite2CC(x, bufferPos, spritePri, pattern, color, palette, start, finish) {
        var finalColor;
        for (var i = finish - 1; i >= start; i = i - 1, x = x + 1, bufferPos = bufferPos + 1) {
            var s = (pattern >> i) & 0x01;
            if (s === 0) continue;
            var prevSpritePri = spritesLinePriorities[x];
            if (prevSpritePri < spritePri) continue;                                        // Higher priority sprite already there
            if (prevSpritePri === spritePri)
                finalColor = color | spritesLineColors[x];                                  // Mix if same priority
            else {
                spritesLinePriorities[x] = spritePri;                                       // Otherwise register new priority
                finalColor = color;
            }
            spritesLineColors[x] = finalColor;                                              // Register new color
            frameBackBuffer[bufferPos] = palette[finalColor];
        }
    }

    function paintSprite2D(x, y, bufferPos, spritePri, pattern, color, palette, start, finish, collide) {
        for (var i = finish - 1; i >= start; i = i - 1, x = x + 1, bufferPos = bufferPos + 1) {
            var s = (pattern >> (i >>> 1)) & 0x01;
            if (s === 0) continue;
            if (spritesLinePriorities[x] < spritePri) {                                     // Higher priority sprite already there
                if (collide && !spritesCollided) setSpritesCollision(x, y);
                continue;
            }
            spritesLinePriorities[x] = spritePri;                                           // Register new priority
            spritesLineColors[x] = color;                                                   // Register new color
            frameBackBuffer[bufferPos] = palette[color];
        }
    }

    function paintSprite2DCC(x, bufferPos, spritePri, pattern, color, palette, start, finish) {
        var finalColor;
        for (var i = finish - 1; i >= start; i = i - 1, x = x + 1, bufferPos = bufferPos + 1) {
            var s = (pattern >> (i >>> 1)) & 0x01;
            if (s === 0) continue;
            var prevSpritePri = spritesLinePriorities[x];
            if (prevSpritePri < spritePri) continue;                                        // Higher priority sprite already there
            if (prevSpritePri === spritePri)
                finalColor = color | spritesLineColors[x];                                  // Mix if same priority
            else {
                spritesLinePriorities[x] = spritePri;                                       // Otherwise register new priority
                finalColor = color;
            }
            spritesLineColors[x] = finalColor;                                              // Register new color
            frameBackBuffer[bufferPos] = palette[finalColor];
        }
    }

    function setSpritesCollision(x, y) {
        spritesCollided = true;
        if (spritesCollisionX >= 0) return;                             // Only set if clear
        spritesCollisionX = x + 12; spritesCollisionY = y + 8;          // Additions as per spec
        if ((register[8] & 0xc0) === 0) {                               // Only report if Mouse (MS) and LightPen (LP) are disabled
            status[3] = spritesCollisionX & 255;
            status[4] = 0xfe | (spritesCollisionX >> 8);
            status[5] = spritesCollisionY & 255;
            status[6] = 0xfc | (spritesCollisionY >> 8);
        }
    }

    function refresh() {
        // Send frame to monitor
        videoSignal.newFrame(frameCanvas, 0, 0, signalWidth, signalHeight);
        refreshPending = false;
    }

    function beginFrame() {
        currentScanline = startingScanline;

        // Page blinking
        if (blinkPageDuration > 0) {
            if (--blinkPageDuration === 0) {
                blinkEvenPage = !blinkEvenPage;
                blinkPageDuration = ((register[13] >> (blinkEvenPage ? 4 : 0)) & 0x0f) * 10;        // Duration in frames
            }
        }

        // Field alternance
        status[2] ^= 0x02;                    // Invert EO (Display Field flag)

        // Interlace
        if (register[9] & 0x08) {                                       // IL
            bufferPosition = (status[2] & 0x02) ? LINE_WIDTH : 0;       // EO
            bufferLineAdvance = LINE_WIDTH * 2;
        } else {
            bufferPosition = 0;
            bufferLineAdvance = LINE_WIDTH;
        }

        updatePageAlternance();
    }

    function finishFrame() {

        //var cpuCycles = cpu.getCycles();
        //wmsx.Util.log("Frame FINISHED. CurrentScanline: " + currentScanline + ", CPU cycles: " + (cpuCycles - debugFrameStartCPUCycle));
        //debugFrameStartCPUCycle = cpuCycles;

        // Update frame image from backbuffer
        frameContext.putImageData(frameImageData, 0, 0, 0, 0, signalWidth, signalHeight);
        refreshPending = true;
        frame = frame + 1;

        beginFrame();
    }

    function updateSpritePatternTables() {
        // TODO Revise for Debug modes
        //var vramSpritePatternTable = vram.subarray(spritePatternTableAddress);
        //spritePatternTable8  = debugModeSpriteInfo ? debugPatTableDigits8  : vramSpritePatternTable;
        //spritePatternTable16 = debugModeSpriteInfo ? debugPatTableDigits16 : vramSpritePatternTable;
    }

    function initRegisters() {
        wmsx.Util.arrayFill(register, 0);
        wmsx.Util.arrayFill(status, 0);
        status[1] = 0x00;         // VDP ID. V9938, 1 = V9958
        status[2] = 0x0c;         // Fixed "1" bits
        status[4] = 0xfe;         // Fixed "1" bits
        status[6] = 0xfc;         // Fixed "1" bits
        status[9] = 0xfe;         // Fixed "1" bits
    }

    function initFrameResources() {
        frameCanvas = document.createElement('canvas');
        // Maximum VPD resolution including borders
        frameCanvas.width =  wmsx.V9938.SIGNAL_MAX_WIDTH_V9938;
        frameCanvas.height = wmsx.V9938.SIGNAL_MAX_HEIGHT_V9938;
        frameContext = frameCanvas.getContext("2d");
        //frameImageData = frameContext.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
        frameImageData = frameContext.createImageData(frameCanvas.width, frameCanvas.height);
        frameBackBuffer = new Uint32Array(frameImageData.data.buffer);
    }

    function initColorPalette() {
        var colors = isV9918 ? colorPaletteInitialV9918 : colorPaletteInitialV9938;
        for (var c = 0; c < 16; c = c + 1) {
            colorPalette[c] = colors[c];
            colorPalette[c + 16] = colors[c];
            paletteRegister[c] = paletteRegisterInitialValuesV9938[c];
        }
    }

    function initColorCaches() {
        // Pre calculate all 512 colors encoded in 9 bits, and all 256 colors encoded in 8 bits
        for (var c = 0; c <= 0x1ff; c++) {
            if (c & 1) colors256[c >>> 1] = 0xff000000 | (color2to8bits[(c >>> 1) & 0x3] << 16) | (color3to8bits[c >>> 6] << 8) | color3to8bits[(c >>> 3) & 0x7];
            colors512[c] = 0xff000000 | (color3to8bits[c & 0x7] << 16) | (color3to8bits[c >>> 6] << 8) | color3to8bits[(c >>> 3) & 0x7];
        }
    }

    function initDebugPatternTables() {
        var digitPatterns = [
            ["111", "101", "101", "101", "111"], ["110", "010", "010", "010", "111"], ["111", "001", "111", "100", "111"], ["111", "001", "111", "001", "111"], ["101", "101", "111", "001", "001"],
            ["111", "100", "111", "001", "111"], ["111", "100", "111", "101", "111"], ["111", "001", "001", "001", "001"], ["111", "101", "111", "101", "111"], ["111", "101", "111", "001", "001"],
            ["110", "001", "111", "101", "111"], ["100", "100", "111", "101", "110"], ["000", "111", "100", "100", "111"], ["001", "001", "111", "101", "111"], ["110", "101", "111", "100", "011"], ["011", "100", "110", "100", "100"]
        ];
        var pos8 = 0, pos16 = 0, i = 0;
        for (var info = 0; info < 256; info++) {
            var dig1 = (info / 16) | 0;
            var dig2 = info % 16;
            // 8 x 8
            for (i = 0; i < 5; i++) debugPatTableDigits8[pos8++] = Number.parseInt(digitPatterns[dig1][i] + "0" + digitPatterns[dig2][i] + "0", 2);
            debugPatTableDigits8[pos8++] = Number.parseInt("00000000", 2);
            debugPatTableDigits8[pos8++] = Number.parseInt("01111100", 2);
            debugPatTableDigits8[pos8++] = Number.parseInt("00000000", 2);
            // 16 x 16
            debugPatTableDigits16[pos16++] = Number.parseInt("11111111", 2);
            for (i = 0; i < 4; i++) debugPatTableDigits16[pos16++] = Number.parseInt("10000000", 2);
            for (i = 0; i < 5; i++) debugPatTableDigits16[pos16++] = Number.parseInt("1000" + digitPatterns[dig1][i] + "0", 2);
            for (i = 0; i < 5; i++) debugPatTableDigits16[pos16++] = Number.parseInt("10000000", 2);
            for (i = 0; i < 2; i++) debugPatTableDigits16[pos16++] = Number.parseInt("11111111", 2);
            for (i = 0; i < 4; i++) debugPatTableDigits16[pos16++] = Number.parseInt("00000001", 2);
            for (i = 0; i < 5; i++) debugPatTableDigits16[pos16++] = Number.parseInt("0" + digitPatterns[dig2][i] + "0001", 2);
            for (i = 0; i < 5; i++) debugPatTableDigits16[pos16++] = Number.parseInt("00000001", 2);
            debugPatTableDigits16[pos16++] = Number.parseInt("11111111", 2);
        }
        debugPatTableBlocks[0] = debugPatTableBlocks[7] = 0;
        debugPatTableBlocks[1] = debugPatTableBlocks[2] = debugPatTableBlocks[3] = debugPatTableBlocks[4] = debugPatTableBlocks[5] = debugPatTableBlocks[6] = 0x7e;
    }

    function initSpritesConflictMap() {
        wmsx.Util.arrayFill(spritesLinePriorities, SPRITE_MAX_PRIORITY);
        wmsx.Util.arrayFill(spritesLineColors, 0);
        spritesGlobalPriority = SPRITE_MAX_PRIORITY;      // Decreasing value for sprite priority control. Never resets and lasts for years!
    }


    var SPRITE_MAX_PRIORITY = 9000000000000000;
    var LINE_WIDTH = wmsx.V9938.SIGNAL_MAX_WIDTH_V9938;


    var frame;
    var blinkEvenPage, blinkPageDuration, alternativePageOffset;

    var videoStandard;
    var desiredBaseFrequency;             // Will depend on VideoStandard and detected Host Native Video Frequency
    var vSynchMode;

    var bufferPosition;
    var bufferLineAdvance;
    var currentScanline;

    var cycles, lastCPUCyclesComputed;

    var startingScanline;
    var finishingScanline;
    var startingActiveScanline;
    var startingTopBorderScanline;
    var startingBottomBorderScanline;
    var startingInvisibleScanline;
    var scanlinesPerCycle;
    var pulldownFirstFrameLinesAdjust;
    var refreshPending;

    var verticalIntReached = false;
    var horizontalIntLine = 0;

    var status = new Array(10);
    var register = new Array(47);
    var paletteRegister = new Array(16);

    var mode;
    var modeData;
    var signalWidth, signalHeight;

    var pendingModeChange;
    var pendingBlankingChange;

    var spritesCollided, spritesInvalid, spritesMaxComputed, spritesCollisionX, spritesCollisionY;

    var spritesLinePriorities = new Array(256);
    var spritesLineColors = new Array(256);
    var spritesGlobalPriority;

    var vramPointer = 0;
    var dataToWrite;
    var paletteFirstWrite;

    var backdropColor;
    var backdropValue;
    var backdropFullLine512Values = new Uint32Array(512 + 16 * 2);

    var verticalAdjust, horizontalAdjust;

    var layoutTableAddress;                         // Dynamic values, set by software
    var colorTableAddress;
    var patternTableAddress;
    var spriteAttrTableAddress;
    var spritePatternTableAddress;

    var layoutTableAddressMask;                     // Dynamic values, depends on mode
    var colorTableAddressMask;
    var patternTableAddressMask;

    var layoutTableAddressMaskBase = ~(-1 << 10);   // Fixed base values for all modes
    var colorTableAddressMaskBase = ~(-1 << 6);
    var patternTableAddressMaskBase = ~(-1 << 11);

    var modes = wmsx.Util.arrayFillFunc(new Array(32), function(i) {
        return    { code: 0xff, name: "Invalid",   isV9938: true,  layTBase: -1 << 10, colorTBase: -1 <<  6, patTBase: -1 << 11, sprAttrTBase: -1 <<  7, sprPatTBase: -1 << 11, width:   0, layLineBytes:   0, pageSize:     0, updLine: renderLineBorders, updLineDeb: renderLineBorders,     spriteMode: 0 };
    });

    modes[0x10] = { code: 0x10, name: "Screen 0",  isV9938: false, layTBase: -1 << 10, colorTBase:        0, patTBase: -1 << 11, sprAttrTBase:        0, sprPatTBase:        0, width: 256, layLineBytes:   0, pageSize:     0, updLine: renderLineModeT1,  updLineDeb: renderLineModeT1Debug, spriteMode: 0 };
    modes[0x12] = { code: 0x12, name: "Screen 0+", isV9938: true,  layTBase: -1 << 12, colorTBase: -1 <<  9, patTBase: -1 << 11, sprAttrTBase:        0, sprPatTBase:        0, width: 512, layLineBytes:   0, pageSize:     0, updLine: renderLineModeT2,  updLineDeb: renderLineModeT2     , spriteMode: 0 };
    modes[0x08] = { code: 0x08, name: "Screen 3",  isV9938: false, layTBase: -1 << 10, colorTBase:        0, patTBase: -1 << 11, sprAttrTBase: -1 <<  7, sprPatTBase: -1 << 11, width: 256, layLineBytes:   0, pageSize:     0, updLine: renderLineModeMC,  updLineDeb: renderLineModeMCDebug, spriteMode: 1 };
    modes[0x00] = { code: 0x00, name: "Screen 1",  isV9938: false, layTBase: -1 << 10, colorTBase: -1 <<  6, patTBase: -1 << 11, sprAttrTBase: -1 <<  7, sprPatTBase: -1 << 11, width: 256, layLineBytes:   0, pageSize:     0, updLine: renderLineModeG1,  updLineDeb: renderLineModeG1Debug, spriteMode: 1 };
    modes[0x01] = { code: 0x01, name: "Screen 2",  isV9938: false, layTBase: -1 << 10, colorTBase: -1 << 13, patTBase: -1 << 13, sprAttrTBase: -1 <<  7, sprPatTBase: -1 << 11, width: 256, layLineBytes:   0, pageSize:     0, updLine: renderLineModeG2,  updLineDeb: renderLineModeG2Debug, spriteMode: 1 };
    modes[0x02] = { code: 0x02, name: "Screen 4",  isV9938: true,  layTBase: -1 << 10, colorTBase: -1 << 13, patTBase: -1 << 13, sprAttrTBase: -1 << 10, sprPatTBase: -1 << 11, width: 256, layLineBytes:   0, pageSize:     0, updLine: renderLineModeG3,  updLineDeb: renderLineModeG3     , spriteMode: 2 };
    modes[0x03] = { code: 0x03, name: "Screen 5",  isV9938: true,  layTBase: -1 << 15, colorTBase:        0, patTBase:        0, sprAttrTBase: -1 << 10, sprPatTBase: -1 << 11, width: 256, layLineBytes: 128, pageSize: 32768, updLine: renderLineModeG4,  updLineDeb: renderLineModeG4     , spriteMode: 2 };
    modes[0x04] = { code: 0x04, name: "Screen 6",  isV9938: true,  layTBase: -1 << 15, colorTBase:        0, patTBase:        0, sprAttrTBase: -1 << 10, sprPatTBase: -1 << 11, width: 512, layLineBytes: 128, pageSize: 32768, updLine: renderLineModeG5,  updLineDeb: renderLineModeG5     , spriteMode: 2 };
    modes[0x05] = { code: 0x05, name: "Screen 7",  isV9938: true,  layTBase: -1 << 16, colorTBase:        0, patTBase:        0, sprAttrTBase: -1 << 10, sprPatTBase: -1 << 11, width: 512, layLineBytes: 256, pageSize: 65536, updLine: renderLineModeG6,  updLineDeb: renderLineModeG6     , spriteMode: 2 };
    modes[0x07] = { code: 0x07, name: "Screen 8",  isV9938: true,  layTBase: -1 << 16, colorTBase:        0, patTBase:        0, sprAttrTBase: -1 << 10, sprPatTBase: -1 << 11, width: 256, layLineBytes: 256, pageSize: 65536, updLine: renderLineModeG7,  updLineDeb: renderLineModeG7     , spriteMode: 2 };

    var renderLine, renderLineActive, renderSpritesLine, blankedLineValues;         // Update functions for current mode
    var renderSpritesLineFunctionsMode1 = [renderSprites1LineSize0, renderSprites1LineSize1, renderSprites1LineSize2, renderSprites1LineSize3 ];
    var renderSpritesLineFunctionsMode2 = [renderSprites2LineSize0, renderSprites2LineSize1, renderSprites2LineSize2, renderSprites2LineSize3 ];

    var vram = wmsx.Util.arrayFill(new Array(wmsx.V9938.VRAM_LIMIT + 1), 0);
    this.vram = vram;


    // Planes as off-screen canvas

    var frameCanvas, frameContext, frameImageData, frameBackBuffer;


    var colors256 = new Uint32Array(256);       // 32 bit ABGR values for 8 bit GRB colors
    var colors512 = new Uint32Array(512);       // 32 bit ABGR values for 9 bit GRB colors
    var color2to8bits = [ 0, 73, 146, 255 ];
    var color3to8bits = [ 0, 36, 73, 109, 146, 182, 219, 255 ];

    var color0Solid = false;
    var colorPalette = new Uint32Array(32);     // 32 bit ABGR palette values ready to paint. 0-15 values with transparency pre-computed in position 0. 16-31 with real solid palette values

    var colorPaletteG7 =           new Uint32Array([ 0xff000000, 0xff490000, 0xff00006d, 0xff49006d, 0xff006d00, 0xff496d00, 0xff006d6d, 0xff496d6d, 0xff4992ff, 0xffff0000, 0xff0000ff, 0xffff00ff, 0xff00ff00, 0xffffff00, 0xff00ffff, 0xffffffff ]);

    var colorPaletteInitialV9938 = new Uint32Array([ 0xff000000, 0xff000000, 0xff24db24, 0xff6dff6d, 0xffff2424, 0xffff6d49, 0xff2424b6, 0xffffdb49, 0xff2424ff, 0xff6d6dff, 0xff24dbdb, 0xff92dbdb, 0xff249224, 0xffb649db, 0xffb6b6b6, 0xffffffff ]);
    var colorPaletteInitialV9918 = new Uint32Array([ 0xff000000, 0xff000000, 0xff28ca07, 0xff65e23d, 0xfff04444, 0xfff46d70, 0xff1330d0, 0xfff0e840, 0xff4242f3, 0xff7878f4, 0xff30cad0, 0xff89dcdc, 0xff20a906, 0xffc540da, 0xffbcbcbc, 0xffffffff ]);
    var paletteRegisterInitialValuesV9938 = [ 0x000, 0x000, 0x189, 0x1db, 0x04f, 0x0d7, 0x069, 0x197, 0x079, 0x0fb, 0x1b1, 0x1b4, 0x109, 0x0b5, 0x16d, 0x1ff ];


   // Sprite and Debug Modes controls

    var debugMode;
    var debugModeSpriteInfo, debugModeSpriteInfoNames;
    var debugModePatternInfo, debugModePatternInfoBlocks, debugModePatternInfoNames;

    var spriteDebugMode;
    var spriteDebugModeLimit = true;
    var spriteDebugModeCollisions = true;

    var debugPatTableDigits8 =  new Array(256 * 8);            // 8x8
    var debugPatTableDigits16 = new Array(256 * 8 * 4);        // 16x16
    var debugPatTableBlocks =   new Array(8);                  // 8x8
    var debugBackdropValue    = 0xff2a2a2a;

    var spritePatternTable8, spritePatternTable16;                  // Tables to use depending on Debug/Non-Debug Modes

    var debugFrameStartCPUCycle = 0;
    var debugLineStartCPUCycles = 0;


    // Connections

    var videoSignal;
    var cpuClockPulses;
    var psgClockPulse;
    var commandProcessor;

    // Savestate  -------------------------------------------

    this.saveState = function() {
        return {
            v1: isV9918,
            l: currentScanline, b: bufferPosition, ba: bufferLineAdvance,
            c: cycles, cc: lastCPUCyclesComputed,
            vp: vramPointer, d: dataToWrite, pw: paletteFirstWrite,
            ha: horizontalAdjust, va: verticalAdjust, hil: horizontalIntLine,
            bp: blinkEvenPage, bpd: blinkPageDuration,
            pmc: pendingModeChange, pbc: pendingBlankingChange,
            sc: spritesCollided, sx: spritesCollisionX, sy: spritesCollisionY, si: spritesInvalid, sm: spritesMaxComputed,
            vi: verticalIntReached,
            r: wmsx.Util.storeInt8BitArrayToStringBase64(register), s: wmsx.Util.storeInt8BitArrayToStringBase64(status), p: wmsx.Util.storeInt8BitArrayToStringBase64(paletteRegister),
            pal: wmsx.Util.storeInt32BitArrayToStringBase64(colorPalette),
            vram: wmsx.Util.compressInt8BitArrayToStringBase64(vram),
            cp: commandProcessor.saveState()
        };
    };

    this.loadState = function(s) {
        isV9918 = s.v1;
        currentScanline = s.l; bufferPosition = s.b; bufferLineAdvance = s.ba;
        cycles = s.c; lastCPUCyclesComputed = s.cc;
        vramPointer = s.vp; dataToWrite = s.d; paletteFirstWrite = s.pw;
        horizontalAdjust = s.ha; verticalAdjust = s.va; horizontalIntLine = s.hil;
        blinkEvenPage = s.bp; blinkPageDuration = s.bpd;
        pendingModeChange = s.pmc; pendingBlankingChange = s.pbc;
        spritesCollided = s.sc; spritesCollisionX = s.sx; spritesCollisionY = s.sy; spritesInvalid = s.si; spritesMaxComputed = s.sm;
        verticalIntReached = s.vi;
        register = wmsx.Util.restoreStringBase64ToInt8BitArray(s.r, register); status = wmsx.Util.restoreStringBase64ToInt8BitArray(s.s, status); paletteRegister = wmsx.Util.restoreStringBase64ToInt8BitArray(s.p, paletteRegister);
        var c = wmsx.Util.restoreStringBase64ToInt32BitArray(s.pal, colorPalette);
        if (colorPalette !== c) colorPalette = new Uint32Array(c);              // Must preserve type Uint32Array
        vram = wmsx.Util.uncompressStringBase64ToInt8BitArray(s.vram, vram);
        commandProcessor.loadState(s.cp);
        commandProcessor.connectVDP(this, vram, register, status);
        updateIRQ();
        updateMode();
        updateBackdropColor(true);
        updateTransparency();
        updatePageAlternance();
        initSpritesConflictMap();
    };


    init();


    function logInfo(text) {
        console.log(text + ". Frame: " + frame + ", line: " + (currentScanline - startingActiveScanline) + ", cpuCycle: " + (cpu.getCycles() - debugLineStartCPUCycles));
    }
    this.logInfo = logInfo;

    this.eval = function(str) {
        return eval(str);
    };

};

wmsx.V9938.VRAM_LIMIT = 0x1ffff;      // 128K

wmsx.V9938.SIGNAL_MAX_WIDTH_V9938 = 512 + 16 * 2;
wmsx.V9938.SIGNAL_MAX_HEIGHT_V9938 = (212 + 8 * 2) * 2;

wmsx.V9938.SIGNAL_WIDTH_V9918 =  256 + 8 * 2;
wmsx.V9938.SIGNAL_HEIGHT_V9918 = 192 + 8 * 2;

