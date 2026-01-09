package com.sneha.tution.keyboard

import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.textinput.ReactEditText
import com.facebook.react.views.textinput.ReactTextInputManager
import com.facebook.react.bridge.ReadableArray

/**
 * Manager that behaves like ReactTextInputManager so TextInput props/events work,
 * but uses our RichReactEditText to support onReceiveContent from keyboards.
 */
class RichEditTextManager : ReactTextInputManager() {
  override fun getName(): String = "RichEditText"

  override fun createViewInstance(reactContext: ThemedReactContext): ReactEditText {
    return RichReactEditText(reactContext)
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
    // Merge base TextInput events with our custom onRichContent event
    val base = super.getExportedCustomDirectEventTypeConstants() ?: HashMap()
    val extra = MapBuilder.of(
      "onRichContent", MapBuilder.of("registrationName", "onRichContent")
    )
    base.putAll(extra)
    return base
  }

  // Optional map for numeric command IDs (Paper UIManager)
  override fun getCommandsMap(): MutableMap<String, Int> {
    return MapBuilder.of(
      "forceClearAndRestartIme", 1,
      "setTextFromJs", 2
    )
  }

  // Handle string command IDs
  override fun receiveCommand(view: ReactEditText, commandId: String?, args: ReadableArray?) {
    super.receiveCommand(view, commandId, args)
    if (view is RichReactEditText) {
      when (commandId) {
        "forceClearAndRestartIme" -> view.forceClearAndRestartIme()
        "setTextFromJs" -> {
          val text = args?.getString(0) ?: ""
          view.applyTextFromJs(text)
        }
      }
    }
  }

  // Handle numeric command IDs
  override fun receiveCommand(view: ReactEditText, commandId: Int, args: ReadableArray?) {
    super.receiveCommand(view, commandId, args)
    if (view is RichReactEditText) {
      when (commandId) {
        1 -> view.forceClearAndRestartIme()
        2 -> {
          val text = args?.getString(0) ?: ""
          view.applyTextFromJs(text)
        }
      }
    }
  }
}
