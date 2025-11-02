import { useEffect, useState } from 'react'
import { supabase, type Item } from './lib/supabase'

function getSessionId(): string {
  let sessionId = localStorage.getItem('voting_session_id')
  if (!sessionId) {
    sessionId = crypto.randomUUID()
    localStorage.setItem('voting_session_id', sessionId)
  }
  return sessionId
}

export default function App() {
  const [items, setItems] = useState<Item[]>([])
  const [userVotes, setUserVotes] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const sessionId = getSessionId()

  useEffect(() => {
    fetchItems()
    fetchUserVotes()

    // Subscribe to real-time updates
    const channel = supabase
      .channel('items-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'items'
        },
        () => {
          fetchItems()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  async function fetchItems() {
    const { data, error } = await supabase
      .from('items')
      .select('*')
      .order('id', { ascending: true })

    if (error) {
      console.error('Error fetching items:', error)
    } else {
      console.log('Fetched items:', data)
      setItems(data || [])
    }
    setLoading(false)
  }

  async function fetchUserVotes() {
    const { data, error } = await supabase
      .from('likes')
      .select('item_id')
      .eq('session_id', sessionId)

    if (error) {
      console.error('Error fetching user votes:', error)
    } else {
      setUserVotes(new Set(data?.map((like: { item_id: string }) => like.item_id) || []))
    }
  }

  async function toggleVote(itemId: string) {
    const hasVoted = userVotes.has(itemId)

    if (hasVoted) {
      // Remove vote
      const { error } = await supabase
        .from('likes')
        .delete()
        .eq('item_id', itemId)
        .eq('session_id', sessionId)

      if (error) {
        console.error('Error removing vote:', error)
        return
      }

      // Update local state
      setUserVotes(prev => {
        const newSet = new Set(prev)
        newSet.delete(itemId)
        return newSet
      })

      // Optimistically update likes count
      setItems(prev =>
        prev.map(item =>
          item.id === itemId
            ? { ...item, likes_count: item.likes_count - 1 }
            : item
        )
      )
    } else {
      // Add vote
      const { error } = await supabase
        .from('likes')
        .insert({ item_id: itemId, session_id: sessionId })

      if (error) {
        console.error('Error adding vote:', error)
        return
      }

      // Update local state
      setUserVotes(prev => new Set(prev).add(itemId))

      // Optimistically update likes count
      setItems(prev =>
        prev.map(item =>
          item.id === itemId
            ? { ...item, likes_count: item.likes_count + 1 }
            : item
        )
      )
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-2xl font-semibold font-space-grotesk text-foreground">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold text-foreground mb-4 font-space-grotesk">
            50 Things Sasha Knows
          </h1>
          <p className="text-foreground/80 text-lg max-w-2xl mx-auto leading-relaxed mb-6">
            From Sasha Chapin's essay{' '}
            <a
              href="https://sashachapin.substack.com/p/50-things-i-know"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline font-semibold"
            >
              "50 Things I Know"
            </a>
            . Vote for the things you find most resonant.
          </p>
          <p className="text-foreground/60 text-base max-w-2xl mx-auto">
            Click the moon to toggle your vote — you can vote for as many as you want!
          </p>
        </div>

        {/* Items List */}
        <div className="space-y-3">
          {items.map((item) => {
            const hasVoted = userVotes.has(item.id)
            return (
              <div
                key={item.id}
                onClick={() => toggleVote(item.id)}
                className="bg-card border-2 border-border rounded-xl p-6 cursor-pointer transition-all duration-200 hover:border-primary hover:shadow-lg group"
              >
                <div className="flex items-start justify-between gap-6">
                  <div className="flex-1">
                    <p className="text-card-foreground text-base leading-relaxed">
                      {item.label}
                    </p>
                  </div>
                  <div className="flex flex-col items-center gap-1 min-w-[70px]">
                    <button
                      className="text-4xl transition-all duration-200 group-hover:scale-110"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleVote(item.id)
                      }}
                    >
                      {hasVoted ? '🌕' : '🌑'}
                    </button>
                    <span className="text-foreground/60 font-semibold text-sm font-jetbrains">
                      {item.likes_count}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="mt-12 text-center">
          <p className="text-foreground/60 text-sm font-jetbrains">
            You've voted for {userVotes.size} item{userVotes.size !== 1 ? 's' : ''}
          </p>
        </div>
      </div>
    </div>
  )
}
