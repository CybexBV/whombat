/**
 * Scanning a QR code (AP-27): the claim card's, or the computer's sign-in code (AP-532). A full-screen camera
 * (expo-camera) that reads QR codes only, with a viewfinder over it. Camera permission is asked when the scanner opens
 * — never earlier — and a refusal sends the person back to the other way (typing the card, email). `onScanned`
 * answers null when the text was what the caller wanted (the scanner closes) or a line to show when it wasn't (it
 * keeps looking). The words default to the claim card's.
 */
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FullScreenModal } from '../ui/fullScreen';
import { X } from '../ui/icons';
import { Loading } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { COPY } from './copy';

export function QrScanner({
  visible,
  onClose,
  onDenied,
  onScanned,
  title = COPY.claim.scanTitle,
  closeLabel = COPY.claim.scanClose,
  escapeLabel = COPY.claim.typeIt,
  onEscape,
}: {
  visible: boolean;
  onClose: () => void;
  onDenied: () => void;
  onScanned: (text: string) => string | null;
  /** The header (and the camera's accessible name). */
  title?: string;
  closeLabel?: string;
  /** The way out under the camera (“Type the card instead”); `onEscape`, else it closes. */
  escapeLabel?: string;
  onEscape?: () => void;
}) {
  const theme = useTheme();
  const [permission, request] = useCameraPermissions();
  const [problem, setProblem] = useState<string | null>(null);
  const asked = useRef(false);
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) {
      asked.current = false;
      last.current = null;
      setProblem(null);
      return;
    }
    if (!permission || permission.granted || asked.current) return;
    asked.current = true;
    if (!permission.canAskAgain) {
      onDenied();
      return;
    }
    void request().then((r) => {
      if (!r.granted) onDenied();
    });
  }, [visible, permission, request, onDenied]);

  const onBarcode = (result: BarcodeScanningResult) => {
    if (result.data === last.current) return;
    last.current = result.data;
    setProblem(onScanned(result.data));
  };

  return (
    <FullScreenModal visible={visible} animationType="slide" onClose={onClose}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, minHeight: 56 }}
      >
        <Touchable
          onPress={onClose}
          accessibilityLabel={closeLabel}
          feedback="wash"
          ringRadius={22}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={20} color={theme.colors.ink} strokeWidth={2} />
        </Touchable>
        <Text size={15} weight={600} numberOfLines={2} style={{ flex: 1 }} accessibilityRole="header">
          {title}
        </Text>
      </View>
      <View
        style={{
          flex: 1,
          margin: 16,
          borderRadius: 20,
          overflow: 'hidden',
          backgroundColor: theme.colors.sf2,
        }}
      >
        {permission?.granted ? (
          <>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onBarcode}
              accessibilityLabel={title}
            />
            <Viewfinder color={problem ? theme.colors.bad : theme.colors.onSolid} />
          </>
        ) : (
          <Loading />
        )}
      </View>
      <View style={{ paddingHorizontal: 22, paddingBottom: 16, minHeight: 44, justifyContent: 'center' }}>
        {problem ? (
          <Text size={14} color={theme.colors.bad} accessibilityLiveRegion="assertive">
            {problem}
          </Text>
        ) : null}
        <Touchable
          onPress={onEscape ?? onClose}
          feedback="fade"
          accessibilityLabel={escapeLabel}
          style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
        >
          <Text size={15} weight={500} color={theme.colors.brand}>
            {escapeLabel}
          </Text>
        </Touchable>
      </View>
    </FullScreenModal>
  );
}

/** Four rounded corners around the middle of the camera: where the code goes. Decorative. */
function Viewfinder({ color }: { color: string }) {
  const size = 232;
  const arm = 34;
  const w = 4;
  const corner = (v: 'top' | 'bottom', h: 'left' | 'right') => ({
    position: 'absolute' as const,
    width: arm,
    height: arm,
    [v]: 0,
    [h]: 0,
    borderColor: color,
    [`border${v === 'top' ? 'Top' : 'Bottom'}Width`]: w,
    [`border${h === 'left' ? 'Left' : 'Right'}Width`]: w,
    [`border${v === 'top' ? 'Top' : 'Bottom'}${h === 'left' ? 'Left' : 'Right'}Radius`]: 18,
  });
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View style={{ width: size, height: size }}>
        <View style={corner('top', 'left')} />
        <View style={corner('top', 'right')} />
        <View style={corner('bottom', 'left')} />
        <View style={corner('bottom', 'right')} />
      </View>
    </View>
  );
}
