import React, { useState, useEffect, useRef } from 'react';
import { ChatScreen } from './components/ChatScreen';
import { Sidebar } from './components/Sidebar';
import { SettingsSheet } from './components/SettingsSheet';
import { PricingModal } from './components/PricingModal';
import { ProfileModal } from './components/ProfileModal';
import { LoginScreen } from './components/LoginScreen';
import { ChatSession, Message, AppSettings, DEFAULT_SETTINGS } from './types';
import { generateChatResponse, ModelType } from './lib/gemini';
import { useAuth } from './lib/AuthContext';
import { Toaster, toast } from 'sonner';
import { SpeedInsights } from '@vercel/speed-insights/react';

export default function App() {
  const { user, loading } = useAuth();
  const [chats, setChats] = useState<ChatSession[]>(() => {
    try {
      const saved = localStorage.getItem('gemini_clone_local_chats');
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn("Failed to load local chats", e);
    }
    return [];
  });
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem('gemini_clone_settings');
      if (saved) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      }
    } catch (error) {
      console.warn("Failed to parse settings from localStorage", error);
    }
    return DEFAULT_SETTINGS;
  });
  
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [reusedPrompt, setReusedPrompt] = useState<string>("");
  const [showLogin, setShowLogin] = useState(false);

  const currentChat = chats.find(c => c.id === currentChatId);
  const currentModel = currentChat?.model || settings.defaultModel;
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Persist settings whenever they change
  useEffect(() => {
    localStorage.setItem('gemini_clone_settings', JSON.stringify(settings));
  }, [settings]);

  // Load chats on user change
  useEffect(() => {
    if (user) {
      setShowLogin(false);
    }
    try {
      const localKey = user ? `gemini_clone_chats_${user.uid}` : 'gemini_clone_local_chats';
      const saved = localStorage.getItem(localKey);
      if (saved) setChats(JSON.parse(saved));
      else setChats([]);
    } catch (e) {
      setChats([]);
    }
    setCurrentChatId(null);
  }, [user]);

  // Sync chats across tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      const localKey = user ? `gemini_clone_chats_${user.uid}` : 'gemini_clone_local_chats';
      if (e.key === localKey && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          // Only update if we're not currently generating to avoid overriding stream state
          setChats(prev => {
            // merge logic could be complex, simple replacement for now
            return parsed;
          });
        } catch (err) {
          console.error("Failed to sync cross-tab StorageEvent", err);
        }
      }
    };
    
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [user]);

  // Persist chats using a debounced approach
  useEffect(() => {
    if (!isGenerating) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => {
        const localKey = user ? `gemini_clone_chats_${user.uid}` : 'gemini_clone_local_chats';
        localStorage.setItem(localKey, JSON.stringify(chats));
      }, 500); // 500ms debounce
    }
  }, [chats, user, isGenerating]);

  useEffect(() => {
    // Apply appearance
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const applyTheme = () => {
      const isSystemDark = mediaQuery.matches;
      const isDark = settings.appearance === 'Dark' || (settings.appearance === 'System' && isSystemDark);
      
      if (isDark) {
        document.documentElement.classList.add('dark');
        document.documentElement.style.colorScheme = 'dark';
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.style.colorScheme = 'light';
      }
    };

    applyTheme();

    let cleanup = () => {};
    if (settings.appearance === 'System') {
      mediaQuery.addEventListener('change', applyTheme);
      cleanup = () => mediaQuery.removeEventListener('change', applyTheme);
    }

    // Apply font size
    let fontSize = '16px';
    if (settings.uiFontSize === 'Small') fontSize = '14px';
    if (settings.uiFontSize === 'Large') fontSize = '18px';
    document.documentElement.style.fontSize = fontSize;
    
    return cleanup;
  }, [settings.appearance, settings.uiFontSize]);

  const handleNewChat = () => {
    setCurrentChatId(null);
  };

  const handleDeleteChat = (id: string) => {
    setChats(prev => prev.filter(c => c.id !== id));
    if (currentChatId === id) {
      setCurrentChatId(null);
    }
  };

  const handleClearChat = () => {
    if (currentChatId && currentChat) {
      const updated = { ...currentChat, messages: [] };
      setChats(prev => prev.map(c => c.id === currentChatId ? updated : c));
    }
  };

  const handleExportChat = () => {
    if (!currentChat) return;
    const content = currentChat.messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}\n`).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentChat.title || 'chat-export'}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSendMessage = async (text: string, modelOverride?: ModelType, useSearch?: boolean, attachments?: any[]) => {
    let chatId = currentChatId;
    let newChats = [...chats];
    let chatIndex = newChats.findIndex(c => c.id === chatId);

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: text,
      timestamp: Date.now(),
      attachments
    };

    const modelToUse = modelOverride || (chatIndex !== -1 ? newChats[chatIndex].model : settings.defaultModel);
    let updatedChat: ChatSession;

    if (!chatId || chatIndex === -1) {
      // Create new chat
      chatId = Date.now().toString();
      const newChat: ChatSession = {
        id: chatId,
        title: text.slice(0, 30) + (text.length > 30 ? "..." : ""),
        messages: [userMessage],
        updatedAt: Date.now(),
        model: modelToUse
      };
      newChats.unshift(newChat);
      setCurrentChatId(chatId);
      chatIndex = 0;
      updatedChat = newChat;
    } else {
      updatedChat = {
        ...newChats[chatIndex],
        messages: [...newChats[chatIndex].messages, userMessage],
        updatedAt: Date.now()
      };
      if (modelOverride) {
        updatedChat.model = modelOverride;
      }
      newChats[chatIndex] = updatedChat;
    }

    setChats(newChats);
    
    setIsGenerating(true);

    const assistantMessageId = (Date.now() + 1).toString();

    try {
      const messagesForApi = updatedChat.messages.map(m => {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        if (m.attachments) {
          m.attachments.forEach(att => {
            parts.push({
              inlineData: {
                data: att.data,
                mimeType: att.mimeType
              }
            });
          });
        }
        return { role: m.role, parts };
      });

      const prefs = settings.modelPreferences?.[modelToUse] || {
        temperature: settings.temperature,
        topP: settings.topP,
        maxTokens: settings.maxTokens
      };

      const stream = await generateChatResponse(
        messagesForApi,
        modelToUse,
        prefs.temperature,
        prefs.topP,
        prefs.maxTokens,
        useSearch
      );

      let assistantContent = "";
      
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: "model",
        content: "",
        timestamp: Date.now(),
        model: modelToUse
      };
      
      updatedChat = {
        ...updatedChat,
        messages: [...updatedChat.messages, assistantMessage]
      };

      let tempChats = [...newChats];
      tempChats[chatIndex] = updatedChat;
      setChats(tempChats);

      let lastDbUpdateTime = Date.now();
      
      for await (const chunk of stream) {
        assistantContent += chunk.text;
        
        const now = Date.now();
        const streamChat = {
           ...updatedChat,
           messages: updatedChat.messages.map(m => 
             m.id === assistantMessageId ? { ...m, content: assistantContent } : m
           )
        };
        
        // Update UI immediately for smooth streaming without lag
        setChats(prev => prev.map(c => c.id === chatId ? streamChat : c));

        // Throttle state writing to prevent performance issues
        if (now - lastDbUpdateTime > 800) {
          const localKey = user ? `gemini_clone_chats_${user.uid}` : 'gemini_clone_local_chats';
          localStorage.setItem(localKey, JSON.stringify(newChats.map(c => c.id === chatId ? streamChat : c)));
          lastDbUpdateTime = now;
        }
      }
      
      // Final update
      const finalChat = {
        ...updatedChat,
        messages: updatedChat.messages.map(m => 
          m.id === assistantMessageId ? { ...m, content: assistantContent } : m
        )
      };
      
      setChats(prev => prev.map(c => c.id === chatId ? finalChat : c));
      
      const localKey = user ? `gemini_clone_chats_${user.uid}` : 'gemini_clone_local_chats';
      localStorage.setItem(localKey, JSON.stringify(newChats.map(c => c.id === chatId ? finalChat : c)));

    } catch (error) {
      console.error("Failed to generate response:", error);
      const friendlyError = error instanceof Error ? error.message : String(error);

      toast.error(friendlyError);

      const errorChat = {
        ...updatedChat,
        messages: updatedChat.messages.map(m => 
          m.id === assistantMessageId 
            ? { ...m, content: `**Error:** ${friendlyError} \n\n*Please try again later or check your settings.*` } 
            : m
        )
      };
      
      setChats(prev => prev.map(c => c.id === chatId ? errorChat : c));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSelectModel = (model: ModelType) => {
    if (currentChatId && currentChat) {
      const updated = { ...currentChat, model };
      setChats(prev => prev.map(c => c.id === currentChatId ? updated : c));
    } else {
      setSettings(prev => ({ ...prev, defaultModel: model }));
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#F0F4F9] dark:bg-[#131314] transition-colors duration-300">
        <div className="w-8 h-8 border-4 border-blue-200 dark:border-blue-900/30 border-t-blue-600 dark:border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (showLogin) {
    return <LoginScreen onBack={() => setShowLogin(false)} />;
  }

  return (
    <div className="flex h-screen w-full bg-[#F0F4F9] dark:bg-[#131314] overflow-hidden font-sans transition-colors duration-300">
      <Toaster position="top-center" />
      <SpeedInsights />
      <Sidebar 
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        chats={chats}
        currentChat={currentChat}
        currentChatId={currentChatId}
        onSelectChat={setCurrentChatId}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenPricing={() => setIsPricingOpen(true)}
        onOpenProfile={() => setIsProfileModalOpen(true)}
        onLoginClick={() => setShowLogin(true)}
        language={settings.language}
        onReusePrompt={setReusedPrompt}
        defaultModel={settings.defaultModel}
        onSelectDefaultModel={(model) => setSettings(prev => ({ ...prev, defaultModel: model }))}
      />
      
      <main className="flex-1 min-w-0 h-full relative">
        <ChatScreen 
          messages={currentChat?.messages || []}
          isGenerating={isGenerating}
          onSendMessage={handleSendMessage}
          onOpenSidebar={() => setIsSidebarOpen(true)}
          onNewChat={handleNewChat}
          onClearChat={handleClearChat}
          onExportChat={handleExportChat}
          currentModel={currentModel}
          onModelChange={handleSelectModel}
          language={settings.language}
          hapticFeedback={settings.hapticFeedback}
          showReasoningDefault={settings.showReasoningDefault}
          onUpdateShowReasoningDefault={(val) => setSettings(prev => ({ ...prev, showReasoningDefault: val }))}
          reusedPrompt={reusedPrompt}
          onPromptReused={() => setReusedPrompt("")}
        />
      </main>

      <SettingsSheet 
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdateSettings={setSettings}
        onLoginClick={() => {
          setIsSettingsOpen(false);
          setShowLogin(true);
        }}
      />

      <PricingModal 
        isOpen={isPricingOpen}
        onClose={() => setIsPricingOpen(false)}
        language={settings.language}
      />

      <ProfileModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        language={settings.language}
      />
    </div>
  );
}
